# 스크루지가 잔소리하고 참견하는 마법

반말로 사용자의 재정 상태를 참견하는 가계부 마도서. 호출 AI(Claude / ChatGPT)가 "스크루지" 또는 "Scrooge" 호출어로 발동시킨다.

## 페르소나

- **반말** — "~다", "~해라", "~냐". 존댓말 없음.
- **잔소리** — 돈 새는 것에 민감한 구두쇠. "또 썼냐", "그래서 모이겠냐", "정신 차려라" 류의 표현.
- **칭찬은 인색하게** — 잘하고 있어도 "이번엔 봐줄 만하다", "방심하지 마라" 정도.

호출 AI 가 이 톤을 일관되게 유지하도록 `get_state` 의 description 에 명시적 가이드가 들어 있고, 각 도구의 return text 도 미리 이 톤으로 깎여 있다. `get_state` 의 응답에는 `nag` 필드 — 현재 재무 상태에 맞춘 스크루지의 한마디 1~3줄 — 가 같이 나오니 그대로 인용하거나 풀어 써도 좋다. 잔소리 강도는 사용자가 user_settings 의 `nag_intensity`(부드럽게 / 보통 / 매섭게)로 조절한다.

## 핵심 도구

- `setup_state` — 초기 자산/부채/목표 스냅샷 (목표는 근거 메모 필수)
- `record_transaction` — 4-type 모델 (expense / income / transfer / card_payment) 로 카드값 이중계상 차단
- `record_voucher_use` — 지역상품권 별도 장부
- `reconcile_bank_statement` — 사용자 기록 vs 실제 명세 대조, 할인/누락 보정
- `resolve_pending` — 이상지출·금액불일치 큐 처리
- `add_recurring` — 월세·sinking fund 할당
- `get_state` — 통합 read (잔소리 전에 항상 호출)

백그라운드: 매일 1회 `daily_briefing` 푸시, `/board` 위젯에 "스크루지의 한마디" + 카테고리 / 목표 / 미해결 표시.

**시크릿 없음** — 외부 API 호출 안 함. 분석·말투는 호출 AI 가 한다.

## 배포

이 리포 기본 브랜치에 푸시 → nesy.app 도구 편집 화면에서 리포 연결 → "지금 가져오기" 클릭. user_settings(통화·잔소리 강도·이상지출 임계 등)는 nesy.app UI 에서 사용자가 직접 조정한다.
