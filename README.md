# 가계부 마도서 (nesy.app.scrooge)

호출 AI(Claude / ChatGPT) 가 사용자의 자산 · 부채 · 거래 · 목표를 기록하고, 현재 재무 상태에 기반한 조언과 경고를 함께 돌려주는 가계부 마도서.

분석이나 말투는 호출 AI 가 직접 한다. 마도서는 데이터 저장 · 잔고 계산 · 경고 신호 생성만 책임진다. 잔소리 강도는 `user_settings.nag_intensity` (부드럽게 / 보통 / 매섭게) 로 조절한다. `get_state` 응답의 `nag` 필드에 현재 상태에 맞춘 경고 1~3줄이 같이 나오니 그대로 인용하거나 풀어 써도 좋다.

## 두 프로세스 — 도구 카탈로그의 구조

가계부는 두 자연스러운 프로세스로 분리된다. 호출 AI 가 사용자 발화를 받자마자 "지금 어느 프로세스인지" 인식하고, 그 프로세스의 단계 순으로 도구를 부르면 헛다리 가능성이 줄어든다.

```
┌─────────────────────────────────────────────────────────────┐
│  [예산] 앞으로 얼마 쓸 수 있나                                │
│    1. setup_state         초기 자산/부채/목표 스냅샷          │
│    2. add_recurring       월 고정비 + sinking fund            │
│    3. set_month_note      월별 회고 + 페이스 한시 오버라이드   │
│    3. transfer_budget     여러 달 묶음 예산 이월              │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  [결산] 실제로 어디에 썼나                                    │
│    1. record_transaction       거래 1건 저장                 │
│    1. record_voucher_use       지역상품권 별도 장부           │
│    2. reconcile_bank_statement 명세 대조 (할인/누락 보정)     │
│    3. resolve_pending          이상지출/금액불일치 큐 처리    │
│    4. list_transactions        거래 조회                     │
│    4. update_entry             항목 수정 (잔고 보정 포함)     │
│    4. delete_entry             항목 삭제                     │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  [공통] 페이스 점검 (조언 · 경고 전에 항상 호출)              │
│    get_state              통합 read + process_hints 안내     │
└─────────────────────────────────────────────────────────────┘
```

`get_state` 응답의 `process_hints` 필드가 "다음 어느 도구를 어떤 인자로 부르면 되는지" 라인별로 안내한다 — 호출 AI 는 그걸 그대로 인용해도 된다.

## 도구 (12개)

### 예산 프로세스

- **`setup_state`** — 초기 자산 / 부채 / 목표 스냅샷. **현재 시점 잔액을 강제 덮어쓰기** 합니다. 거래 누적 없이 그 자리에 박아 넣음. 잔고 보정용으로 다시 부르지 마세요.
- **`add_recurring`** — 월 고정비 (kind=expense), 정기 수입 (kind=income), sinking fund (kind=sinking_fund, 연간 비정기 큰 지출). day_of_month 가능하면 채울 것. sinking_fund 는 일부를 미리 결제하면 마도서가 동적으로 남은 금액을 남은 개월로 재분할 (sinking_fund_breakdown 참고).
- **`set_month_note`** — 월별 회고 메모 + 페이스 목표 오버라이드 (`needed_per_month` 한시 강제). 같은 달 재호출 시 덮어쓰기. 자동 만료 없음 — `delete_entry(entity_type='month_note', id='YYYY-MM')` 로 해제.
- **`transfer_budget`** — 여러 달 묶음 예산 이월·땡겨오기. 어머니 용돈처럼 한 달 큰 지출을 다른 달(들)의 예산에서 평준화. 마도서가 from / to 들의 `month_note + goal_override` 일관성을 자동으로 박음 — 호출 AI 가 산식·연쇄호출에서 헛다리 짚지 않게.

### 결산 프로세스

- **`record_transaction`** — 거래 1건을 저장하고 **기존 잔고에 누적**합니다. 4-type 모델 (expense / income / transfer / card_payment) 로 카드값 이중계상 차단. recurring 의 인스턴스라면 `recurring_id` 반드시 채울 것 (안 채우면 month_forecast 가 과대 예측 + sinking_fund commit 재계산 안 됨).
- **`record_voucher_use`** — 지역상품권 등 별도 장부.
- **`reconcile_bank_statement`** — 사용자 기록 vs 실제 명세 대조, 할인 / 누락 보정.
- **`resolve_pending`** — 이상지출 · 금액불일치 큐 처리.
- **`list_transactions`** — 거래 내역 조회. month / date 범위 + type / category / merchant / account / recurring_id 필터. **응답 `text` 에 거래 한 건씩 풀어 쓴 markdown (날짜, 상호, 카테고리, 금액, account 이름, id) + 집계** — 호출 AI 가 이걸 보고 디테일 답함. cursor pagination (기본 100, max 500). get_state.recent_transactions 가 10건만 줄 때 전체 조회 경로.
- **`update_entry`** — 전 entity_type 수정 (account / debt / recurring / transaction / voucher_use / month_note / goal). **값을 그대로 덮어쓰기.** 잔고가 실제 통장과 어긋났을 때는 `setup_state` 가 아니라 이 도구로 직접 balance 를 보정합니다. 이미 입력한 거래에 누락된 recurring_id 를 채우는 경로이기도 함.
- **`delete_entry`** — 전 entity_type 삭제. transaction 은 잔고 자동 역연산, voucher_use 는 바우처 잔액 자동 보정, month_note 의 오버라이드는 해제 즉시 글로벌 산식 복귀.

### 공통

- **`get_state`** — 통합 read. 조언 · 경고 전에 항상 호출. `process_hints` + `nag` + `this_month_note` + `month_notes_recent` + `_meta` 필드 다 포함.

### record_transaction vs update_entry — 헷갈리지 마세요

| 상황 | 도구 | 동작 |
|---|---|---|
| 평소 거래 (도나쓰 만원 사 먹음) | `record_transaction` | 거래 row 저장 + 기존 잔고에 ±10,000 누적 |
| 마도서 잔고가 실제 통장과 어긋남 (가짜 거래 박지 말고) | `update_entry` | `balance` 를 실잔액으로 직접 덮어쓰기 |
| 초기 셋업 또는 전체 재구축 | `setup_state` | 계좌 · 부채 · 목표 일괄 덮어쓰기 |

## 부분 응답 — `_meta` 필드 확인 정책

`get_state` 가 돌려주는 일부 필드는 cap 이 걸린 부분 응답이다. 그 옆에 `_meta` 형제 필드로 전체 개수·is_partial 을 같이 노출한다. 호출 AI 가 부분 응답을 "전체" 로 오인하지 않게 하기 위함.

| 필드 | 메타 | 전체 조회 경로 |
|---|---|---|
| `recent_transactions` (최근 10건) | `recent_transactions_meta { limit, returned, total_this_month, is_partial, note }` | `list_transactions(month=...)` |
| `month_notes_recent` (최근 6개) | `month_notes_meta { limit, total, is_partial }` | (현재 별도 전체 조회 없음 — 필요 시 후속) |
| `pending` | `pending_meta { returned, total }` | (전체를 항상 노출 — cap 닿으면 그때 잘림) |

★ **사용자가 "이번 달 식비 다 보여줘" 류 질문할 때 recent_transactions 10건만 보고 답하지 말고 반드시 `is_partial=true` 확인 → list_transactions 호출.**

## 월 페이스 판단 — projection 기반

호출 AI 가 "이번 달 흑자/적자, 목표 페이스 OK?" 를 판단할 때 현재 시점 snapshot 만 보면 안 된다. 남은 일수에 빠질 정기 지출 (월세, 차량할부, 관리비, 통신비 …) 을 빼먹는다. `get_state` 의 `month_forecast` 와 `pace_vs_goal.month_on_track` 을 반드시 사용.

```
get_state 응답에서 페이스 판단에 쓰는 필드:
  pace_vs_goal.month_on_track       ← 이걸 본다
  pace_vs_goal.projected_month_pl   ← 이번 달 최종 예상 net
  pace_vs_goal.month_shortfall      ← 부족분 (양수 = 부족)
  month_forecast.upcoming_recurring ← 아직 안 빠진 정기 항목 (이 달 며칠에 얼마)
  month_forecast.recurring_missing_this_month ← 처리 예정일 지났는데 매칭 없는 항목 (구조화)
  month_forecast.sinking_fund_breakdown ← 각 sinking_fund 의 paid_this_year / remaining / monthly_commit
  month_forecast.sinking_fund_monthly_commit ← 약속된 sinking_fund 차감 (동적, 부분 결제 반영)
```

**발생주의 vs 현금주의**: `total_expense` 와 `current_month_pl` 은 새로 발생한 지출 기준 (발생주의). `total_card_payment` 는 이전 달 지출의 정산이라 P&L 영향 없음 — 페이스에 합산하지 마라. 마도서가 이미 별도 필드로 분리해서 돌려준다.

## recurring_id 워크플로 — month_forecast 정확도

`record_transaction` 시 이 거래가 등록된 정기 항목의 이번 달 인스턴스라면 `recurring_id` 를 채워라. 그래야 `month_forecast` 가 "이미 처리됨" 판정해서 같은 항목을 또 차감하지 않는다. **sinking_fund 의 경우 더 중요하다 — `recurring_id` 없으면 마도서가 그 결제를 인식하지 못해 monthly_commit 재계산도 안 된다.**

- `add_recurring` 호출 시 반환된 id 를 기억
- 사용자가 "월세 빠졌어" 하면 → `get_state.recurring` 배열에서 "LH 월세" 의 id 찾기 → `record_transaction(..., recurring_id: 그_id)`
- **이미 입력한 거래에 recurring_id 가 빠진 경우** → `update_entry(entity_type='transaction', month='YYYY-MM', id='...', patch={recurring_id:'...'})` 로 채우면 즉시 정확해짐.
- `day_of_month` 가 채워져 있으면 정확한 날짜 기반 예측. 비어 있으면 비례 배분 추정 (`estimation_notes` 에 안내가 나옴 — 사용자에게 정확한 날짜 물어봐서 `update_entry` 로 채워라)

## sinking_fund 부분 결제 — 동적 commit

연 1회 자동차세, 분기별 보험 같은 sinking_fund 는 보통 `annual_amount / 12` 만큼 매월 미리 할당한다. 사용자가 그 항목의 일부를 미리 결제하면 (예: 보험 할부 — 5월에 30만 결제) 마도서가 동적으로 다시 계산한다:

```
paid_this_year = 이번 연도에 recurring_id 매칭된 거래의 합
remaining = max(0, annual_amount - paid_this_year)
months_left_in_year = 13 - 현재월     # 5월이면 8 (5~12월 포함)
monthly_commit = remaining / months_left_in_year
```

- `month_forecast.sinking_fund_breakdown[]` 에 각 sinking_fund 의 `{id, name, annual_amount, paid_this_year, paid_count, remaining, months_left_in_year, monthly_commit}` 노출.
- 부분 결제가 있으면 `estimation_notes` 에 "보험 — 연 120만 중 30만 결제됨 (2건). 남은 90만을 8개월 동안 월 11.25만 페이스로 차감." 자동 안내.
- 부분 결제 시 record_transaction 에 **반드시 `recurring_id`** 채울 것. 안 채우면 마도서가 인식 못 함.
- 비용: sinking_fund 등록이 1개 이상이면서 이번 달 조회일 때만 추가 list 호출 (연도 전체). 없으면 비용 0.

## 월별 메모 + 목표 오버라이드 (단일 달)

특정 달의 이벤트 회고와 페이스 목표 한시 조정을 위해 `set_month_note` 를 사용한다.

전형적 시나리오: "5월에 장례식 때문에 200만 추가 지출 → 목표 미달. 6월·7월은 `needed_per_month` 30만원으로 고정, 8월에 추이 봐서 재조정."

```
set_month_note(month='2026-06', note='장례비 이연으로 6-7월 한시 완화',
               goal_override={ needed_per_month: 300000,
                               reason: '장례비 이연, 8월 재조정' })
set_month_note(month='2026-07', ... 동일 ...)
```

- 범위는 **단일 달만**. 6월·7월 둘 다 적용하려면 두 번 호출 — 또는 `transfer_budget` 사용.
- `goal_override` 적용 시 `get_state.pace_vs_goal.needed_per_month` 가 산식(`remaining / monthsLeft`) 대신 지정 값으로 덮어쓰임. `needed_per_month_source: 'override'` 로 표시되고 `needed_per_month_formula` 에 원래 산식 결과가 비교용으로 같이 들어감.
- **자동 만료 없음**. 한시 완화 의도였더라도 사용자가 직접 `delete_entry(entity_type='month_note', id='YYYY-MM')` 로 풀어야 함. 마도서가 `nag` 와 `/board` 위젯 상단에 "오버라이드 적용 중" 을 띄워 잊지 않게 한다.
- 부분 수정은 `update_entry(entity_type='month_note', id='YYYY-MM', patch={ note?, goal_override? })`. patch 에서 `goal_override: null` 이면 오버라이드만 해제.
- 회고용 `note` 만 단독으로도 박을 수 있음 (오버라이드 없이). `month_notes_recent` (최근 6개월) 에 누적되어 호출 AI 가 추세 파악에 사용.

## 예산 이월 — `transfer_budget` (여러 달 묶음)

한 달의 갑작스러운 큰 지출을 다른 달(들)의 예산에서 평준화. set_month_note 를 N번 호출하는 것과 같지만 마도서가 산식 계산 + 일관성 박음 — 호출 AI 가 헛다리 짚지 않는다.

```
transfer_budget(from_months=['2026-07','2026-08'],
                to_month='2026-06',
                amount=500000,
                reason='어머니 용돈')

→ 호출 시점 글로벌 산식 needed_per_month 계산
→ 7월·8월 각각 goal_override = formula + 250,000 (강화)
→ 6월 goal_override = max(0, formula - 500,000) (완화)
→ 각 달 month_note 에 transfer_budget 안내 자동 추가
```

- 해제는 각 달 개별: `delete_entry(entity_type='month_note', id='YYYY-MM')`. 일부만 풀어도 다른 달은 그대로 — 일관성은 사용자 책임.
- 호출 AI 가 "다른 달에서 끌어와" 류 요청을 받으면 transfer_budget 1번으로 끝. 자체 산식·연쇄호출 금지.

## 배경 함수

- `daily_briefing` — 일 1회 푸시 알림 (현재 상태 요약).
- `render_board` — 300초마다 위젯 갱신. `/board` 페이지에 "현재 상태 요약" + 카테고리 / 목표 / 미해결 표시.

## 설계 원칙

- **지출과 현금 흐름 분리** — 카드값 결제는 부채 상환이지 지출이 아님. `card_payment` 타입으로 처리.
- **자동 수집 불가** — MCP request-response 구조. 사용자가 호출 AI 에 명세서를 던지면 AI 가 파싱해서 `reconcile_bank_statement` 로 넘김.
- **마통 (마이너스통장) 처리** — 마통은 부채로 등록 후 거래의 `from` / `to` 를 그 부채 id 로 박음. `income` 의 `to_account` 가 부채면 자동으로 빚 감소 처리. `card_payment` 는 카드값 전용이 아니라 자산 → 부채 상환 일반에 사용 (학자금 / 주담대 포함).
- **마도서가 의사결정·계산을 흡수** — 호출 AI 는 "본 신호 + 다음 액션" 을 그대로 인용. AI 가 자체 추론으로 메우는 부분이 적을수록 헛다리 가능성 ↓. `process_hints`, `recurring_missing_this_month`, `sinking_fund_breakdown`, `_meta` 같은 구조화 신호가 모두 이 원리.

**시크릿 없음** — 외부 API 호출 안 함.

## 응답 채널 — `text` 가 메인

nesy.app MCP 가 마도서 응답을 `{ content:[{type:'text', text}], structuredContent:data }` 로 wrap 하는데, Claude MCP 클라이언트가 structuredContent 를 LLM 한테 잘 노출 안 함. → **모든 도구 응답의 `text` 필드 안에 호출 AI 가 답하는 데 필요한 디테일 (id, balance, 거래 목록 등) 이 풀려 있음.** 호출 AI 는 text 만 보고 답 가능 — 별도 채널 보지 마라.

영향:
- `list_transactions.text` — 거래 한 건씩 풀어 쓴 markdown + 카테고리·타입 집계.
- `add_recurring.text` — 등록된 id 박힘 (이후 `record_transaction` 의 `recurring_id` 매칭에 그대로 사용).
- `record_transaction.text` — id + 잔고 변경.
- `update_entry.text` — 갱신된 balance / amount / entity 핵심 값.
- `setup_state.text` — 등록된 키 목록.
- `set_month_note.text` — 등록된 달 + note 미리보기 + 오버라이드 값/사유 + 산식과의 비교.
- `transfer_budget.text` — from/to 별 적용 needed_per_month + 강화/완화 mode 표시.
- `get_state` — 응답 전체가 JSON 으로 노출 (text 필드 없음 → JSON.stringify 경로). `process_hints` 를 통해 다음 액션 안내.

## 배포

이 리포 기본 브랜치에 푸시 → nesy.app 도구 편집 화면에서 리포 연결 → "지금 가져오기" 클릭. `user_settings` (통화 · 잔소리 강도 · 이상지출 임계 등) 는 nesy.app UI 에서 사용자가 직접 조정한다.
