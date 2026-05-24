# 가계부 마도서 (nesy.app.scrooge)

호출 AI(Claude / ChatGPT) 가 사용자의 자산 · 부채 · 거래 · 목표를 기록하고, 현재 재무 상태에 기반한 조언과 경고를 함께 돌려주는 가계부 마도서.

분석이나 말투는 호출 AI 가 직접 한다. 마도서는 데이터 저장 · 잔고 계산 · 경고 신호 생성만 책임진다. 잔소리 강도는 `user_settings.nag_intensity` (부드럽게 / 보통 / 매섭게) 로 조절한다. `get_state` 응답의 `nag` 필드에 현재 상태에 맞춘 경고 1~3줄이 같이 나오니 그대로 인용하거나 풀어 써도 좋다.

## 도구 (10개)

- `setup_state` — 초기 자산 / 부채 / 목표 스냅샷. **현재 시점 잔액을 강제 덮어쓰기** 합니다. 거래 누적 없이 그 자리에 박아 넣음. 잔고 보정용으로 다시 부르지 마세요.
- `record_transaction` — 거래 1건을 저장하고 **기존 잔고에 누적**합니다. 4-type 모델 (expense / income / transfer / card_payment) 로 카드값 이중계상 차단.
- `record_voucher_use` — 지역상품권 등 별도 장부.
- `reconcile_bank_statement` — 사용자 기록 vs 실제 명세 대조, 할인 / 누락 보정.
- `resolve_pending` — 이상지출 · 금액불일치 큐 처리.
- `add_recurring` — 월 고정비 + sinking fund 할당.
- `update_entry` — 전 entity_type 수정. **값을 그대로 덮어쓰기.** 잔고가 실제 통장과 어긋났을 때는 `setup_state` 가 아니라 이 도구로 직접 balance 를 보정합니다.
- `delete_entry` — 전 entity_type 삭제. transaction 은 잔고 자동 역연산, voucher_use 는 바우처 잔액 자동 보정.
- `list_transactions` — 거래 내역 조회. month / date 범위 + type / category / merchant / account / recurring_id 필터. cap 무관한 정확한 집계 (total_amount, by_category, by_type) + cursor pagination.
- `get_state` — 통합 read. 조언 · 경고 전에 항상 호출. `nag` 필드 포함.

### record_transaction vs update_entry — 헷갈리지 마세요

| 상황 | 도구 | 동작 |
|---|---|---|
| 평소 거래 (도나쓰 만원 사 먹음) | `record_transaction` | 거래 row 저장 + 기존 잔고에 ±10,000 누적 |
| 마도서 잔고가 실제 통장과 어긋남 (가짜 거래 박지 말고) | `update_entry` | `balance` 를 실잔액으로 직접 덮어쓰기 |
| 초기 셋업 또는 전체 재구축 | `setup_state` | 계좌 · 부채 · 목표 일괄 덮어쓰기 |

## 월 페이스 판단 — projection 기반

호출 AI 가 "이번 달 흑자/적자, 목표 페이스 OK?" 를 판단할 때 현재 시점 snapshot 만 보면 안 된다. 남은 일수에 빠질 정기 지출 (월세, 차량할부, 관리비, 통신비 …) 을 빼먹는다. `get_state` 의 `month_forecast` 와 `pace_vs_goal.month_on_track` 을 반드시 사용.

```
get_state 응답에서 페이스 판단에 쓰는 필드:
  pace_vs_goal.month_on_track       ← 이걸 본다
  pace_vs_goal.projected_month_pl   ← 이번 달 최종 예상 net
  pace_vs_goal.month_shortfall      ← 부족분 (양수 = 부족)
  month_forecast.upcoming_recurring ← 아직 안 빠진 정기 항목 (이 달 며칠에 얼마)
  month_forecast.sinking_fund_monthly_commit ← 약속된 sinking_fund 차감
```

**발생주의 vs 현금주의**: `total_expense` 와 `current_month_pl` 은 새로 발생한 지출 기준 (발생주의). `total_card_payment` 는 이전 달 지출의 정산이라 P&L 영향 없음 — 페이스에 합산하지 마라. 마도서가 이미 별도 필드로 분리해서 돌려준다.

## recurring_id 워크플로 — month_forecast 정확도

`record_transaction` 시 이 거래가 등록된 정기 항목의 이번 달 인스턴스라면 `recurring_id` 를 채워라. 그래야 `month_forecast` 가 "이미 처리됨" 판정해서 같은 항목을 또 차감하지 않는다.

- `add_recurring` 호출 시 반환된 id 를 기억
- 사용자가 "월세 빠졌어" 하면 → `get_state.recurring` 배열에서 "LH 월세" 의 id 찾기 → `record_transaction(..., recurring_id: 그_id)`
- `day_of_month` 가 채워져 있으면 정확한 날짜 기반 예측. 비어 있으면 비례 배분 추정 (`estimation_notes` 에 안내가 나옴 — 사용자에게 정확한 날짜 물어봐서 `update_entry` 로 채워라)

## 배경 함수

- `daily_briefing` — 일 1회 푸시 알림 (현재 상태 요약).
- `render_board` — 300초마다 위젯 갱신. `/board` 페이지에 "현재 상태 요약" + 카테고리 / 목표 / 미해결 표시.

## 설계 원칙

- **지출과 현금 흐름 분리** — 카드값 결제는 부채 상환이지 지출이 아님. `card_payment` 타입으로 처리.
- **자동 수집 불가** — MCP request-response 구조. 사용자가 호출 AI 에 명세서를 던지면 AI 가 파싱해서 `reconcile_bank_statement` 로 넘김.
- **마통 (마이너스통장) 처리** — 마통은 부채로 등록 후 거래의 `from` / `to` 를 그 부채 id 로 박음. `income` 의 `to_account` 가 부채면 자동으로 빚 감소 처리. `card_payment` 는 카드값 전용이 아니라 자산 → 부채 상환 일반에 사용 (학자금 / 주담대 포함).

**시크릿 없음** — 외부 API 호출 안 함.

## 배포

이 리포 기본 브랜치에 푸시 → nesy.app 도구 편집 화면에서 리포 연결 → "지금 가져오기" 클릭. `user_settings` (통화 · 잔소리 강도 · 이상지출 임계 등) 는 nesy.app UI 에서 사용자가 직접 조정한다.
