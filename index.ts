type Account = { id: string; name: string; type: string; balance: number; currency?: string };
type Debt = { id: string; name: string; type: string; balance: number; due_date?: string };
type Goal = { amount: number; deadline: string; rationale: string; created_at: string };
type Recurring = {
  id: string; name: string; amount: number; kind: 'expense' | 'income' | 'sinking_fund';
  cadence?: string; day_of_month?: number; category?: string; account_id?: string;
};
type Transaction = {
  id: string; type: 'expense' | 'income' | 'transfer' | 'card_payment';
  amount: number; from_account?: string; to_account?: string;
  category?: string; merchant?: string; memo?: string;
  original_amount?: number; date: string; created_at: string;
  recurring_id?: string;  // 이 거래가 어떤 recurring 의 이번 달 인스턴스인지. month_forecast 가 "이미 처리됨" 판정에 사용.
};
type Pending = {
  id: string; kind: 'anomaly' | 'missing_txn' | 'amount_mismatch';
  created_at: string; status: 'pending' | 'resolved';
  data: Record<string, any>;
};

type DataAPI = {
  get(key: string): Promise<any>;
  set(key: string, value: any): Promise<void>;
  delete(key: string): Promise<boolean>;
  list(prefix?: string, limit?: number, startAfter?: string): Promise<Array<{ key: string; value?: any; updated_at: string }>>;
};

const today = () => new Date().toISOString().slice(0, 10);
const thisMonth = () => today().slice(0, 7);
const newId = () => crypto.randomUUID().slice(0, 8);
const now = () => new Date().toISOString();
const fmt = (n: number) => Math.round(n).toLocaleString();

export async function run({ input, data }: {
  input: { tool: string; args: Record<string, any> };
  secrets: Record<string, string>;
  data: DataAPI;
}): Promise<any> {
  const tool = input.tool;
  const args = input.args ?? {};

  switch (tool) {
    case 'setup_state': return setupState(args, data);
    case 'record_transaction': return recordTransaction(args, data);
    case 'record_voucher_use': return recordVoucherUse(args, data);
    case 'reconcile_bank_statement': return reconcileBankStatement(args, data);
    case 'resolve_pending': return resolvePending(args, data);
    case 'add_recurring': return addRecurring(args, data);
    case 'update_entry': return updateEntry(args, data);
    case 'delete_entry': return deleteEntry(args, data);
    case 'list_transactions': return listTransactions(args, data);
    case 'get_state': return getState(args, data);
    case 'daily_briefing': return dailyBriefing(data);
    case 'render_board': return renderBoard(args, data);
    default: throw new Error(`알 수 없는 함수: ${tool}.`);
  }
}

async function setupState(args: any, data: DataAPI) {
  const accounts: Account[] = args.accounts ?? [];
  const debts: Debt[] = args.debts ?? [];
  const goal = args.goal as Omit<Goal, 'created_at'> | undefined;
  const written: string[] = [];

  for (const a of accounts) {
    if (!a.id || !a.name) throw new Error('account 에 id, name 이 필요합니다.');
    await data.set(`account:${a.id}`, { ...a, balance: Number(a.balance) || 0 });
    written.push(`account:${a.id}`);
  }
  for (const d of debts) {
    if (!d.id || !d.name) throw new Error('debt 에 id, name 이 필요합니다.');
    await data.set(`debt:${d.id}`, { ...d, balance: Number(d.balance) || 0 });
    written.push(`debt:${d.id}`);
  }
  if (goal) {
    if (!goal.amount || !goal.deadline) throw new Error('goal 에 amount, deadline 이 필요합니다.');
    if (!goal.rationale) throw new Error('goal.rationale 이 필요합니다. 왜 그 금액·기한인지 산출 근거를 적어주세요 (시간이 지나면 잊습니다).');
    await data.set('goal', { ...goal, created_at: now() });
    written.push('goal');
  }

  return {
    text: `등록 완료: ${written.length}건 (자산 ${accounts.length}, 부채 ${debts.length}${goal ? ', 목표 1' : ''}). 같은 id 가 이미 있었다면 잔고가 덮어쓰기 되었습니다 — 의도가 아니었다면 update_entry 로 보정하세요.`,
    written,
  };
}

async function recordTransaction(args: any, data: DataAPI) {
  const type = args.type as Transaction['type'];
  const amount = Number(args.amount);
  if (!type || !amount) throw new Error('type 과 amount 가 필요합니다.');
  if (!['expense', 'income', 'transfer', 'card_payment'].includes(type)) {
    throw new Error('type 은 expense | income | transfer | card_payment 중 하나여야 합니다.');
  }

  const date = (args.date as string) || today();
  const ym = date.slice(0, 7);
  const id = newId();

  const txn: Transaction = {
    id, type, amount,
    from_account: args.from_account,
    to_account: args.to_account,
    category: args.category,
    merchant: args.merchant,
    memo: args.memo,
    original_amount: args.original_amount ? Number(args.original_amount) : undefined,
    date,
    created_at: now(),
    recurring_id: args.recurring_id || undefined,
  };

  await data.set(`txn:${ym}:${id}`, txn);

  const balanceChanges: string[] = [];
  if (type === 'expense') {
    if (txn.from_account) {
      const acc = await loadAccountOrDebt(data, txn.from_account);
      if (acc?.kind === 'debt') {
        const c = await adjustBalance(data, txn.from_account, +amount);
        if (c) balanceChanges.push(c);
      } else {
        const c = await adjustBalance(data, txn.from_account, -amount);
        if (c) balanceChanges.push(c);
      }
    }
  } else if (type === 'income') {
    if (txn.to_account) {
      const acc = await loadAccountOrDebt(data, txn.to_account);
      if (acc?.kind === 'debt') {
        // to_account 가 부채(마통 등) 면 income = 빚 감소
        const c = await adjustBalance(data, txn.to_account, -amount);
        if (c) balanceChanges.push(c);
      } else {
        const c = await adjustBalance(data, txn.to_account, +amount);
        if (c) balanceChanges.push(c);
      }
    }
  } else if (type === 'transfer') {
    if (txn.from_account) { const c = await adjustBalance(data, txn.from_account, -amount); if (c) balanceChanges.push(c); }
    if (txn.to_account) { const c = await adjustBalance(data, txn.to_account, +amount); if (c) balanceChanges.push(c); }
  } else if (type === 'card_payment') {
    if (txn.from_account) { const c = await adjustBalance(data, txn.from_account, -amount); if (c) balanceChanges.push(c); }
    if (txn.to_account) { const c = await adjustBalance(data, txn.to_account, -amount); if (c) balanceChanges.push(c); }
  }

  let anomalyNote = '';
  if (type === 'expense' && txn.category) {
    const a = await checkAnomaly(data, txn);
    if (a) anomalyNote = ` 참고: ${a}`;
  }

  let lead: string;
  if (type === 'expense') lead = `지출 ${fmt(amount)}원 기록.`;
  else if (type === 'income') lead = `수입 ${fmt(amount)}원 기록.`;
  else if (type === 'transfer') lead = `이체 ${fmt(amount)}원 기록.`;
  else lead = `카드값/부채 상환 ${fmt(amount)}원 기록 (지출로 잡지 않음).`;

  const catTag = (type === 'expense' && txn.category) ? ` (${txn.category})` : '';
  return {
    text: `${lead}${catTag}${anomalyNote}`,
    id,
    balance_changes: balanceChanges,
  };
}

async function loadAccountOrDebt(data: DataAPI, id: string): Promise<{ kind: 'account' | 'debt'; row: any } | null> {
  const a = await data.get(`account:${id}`);
  if (a) return { kind: 'account', row: a };
  const d = await data.get(`debt:${id}`);
  if (d) return { kind: 'debt', row: d };
  return null;
}

async function adjustBalance(data: DataAPI, id: string, delta: number): Promise<string | null> {
  const found = await loadAccountOrDebt(data, id);
  if (!found) return null;
  found.row.balance = (found.row.balance || 0) + delta;
  await data.set(`${found.kind}:${id}`, found.row);
  return `${found.row.name}: ${fmt(found.row.balance)}`;
}

async function checkAnomaly(data: DataAPI, txn: Transaction): Promise<string | null> {
  const settings = (await data.get('__settings')) || {};
  const threshold = Number(settings.anomaly_threshold_ratio) || 2.0;

  const cur = new Date(txn.date + 'T00:00:00Z');
  const months: string[] = [];
  for (let i = 1; i <= 3; i++) {
    const d = new Date(cur);
    d.setUTCMonth(d.getUTCMonth() - i);
    months.push(d.toISOString().slice(0, 7));
  }

  const monthlyResults = await Promise.all(months.map(ym => data.list(`txn:${ym}:`, 1000)));
  const amounts: number[] = [];
  for (const rows of monthlyResults) {
    for (const r of rows) {
      const t = r.value as Transaction;
      if (t && t.type === 'expense' && t.category === txn.category) amounts.push(t.amount);
    }
  }
  if (amounts.length < 3) return null;
  const avg = amounts.reduce((a, b) => a + b, 0) / amounts.length;
  if (txn.amount > avg * threshold) {
    const pid = newId();
    const question = `${txn.category} 카테고리 평균 ${fmt(avg)}원 대비 이번 거래 ${fmt(txn.amount)}원. 사유를 확인하세요.`;
    const pending: Pending = {
      id: pid, kind: 'anomaly', status: 'pending', created_at: now(),
      data: { txn_id: txn.id, category: txn.category, amount: txn.amount, avg, question },
    };
    await data.set(`pending:${pid}`, pending);
    return question;
  }
  return null;
}

async function recordVoucherUse(args: any, data: DataAPI) {
  const name = args.voucher_name as string;
  const amount = Number(args.amount_used);
  if (!name || !amount) throw new Error('voucher_name 과 amount_used 가 필요합니다.');
  const date = (args.date as string) || today();
  const id = newId();
  await data.set(`voucher:${name}:${id}`, {
    id, voucher_name: name, amount_used: amount,
    merchant: args.merchant, memo: args.memo, date, created_at: now(),
  });
  const balKey = `voucher_balance:${name}`;
  const cur = (await data.get(balKey)) as { balance: number } | null;
  const newBal = (cur?.balance ?? 0) - amount;
  await data.set(balKey, { balance: newBal });
  return {
    text: `${name} ${fmt(amount)}원 사용 기록. 잔액 ${fmt(newBal)}원.`,
    id, voucher_balance: newBal,
  };
}

async function reconcileBankStatement(args: any, data: DataAPI) {
  const source = args.source as string;
  const accountId = args.account_id as string;
  const start = args.period_start as string;
  const end = args.period_end as string;
  const bankTxns = (args.transactions as Array<any>) || [];
  const autoAdd = Boolean(args.auto_add);

  if (!source || !accountId || !start || !end) throw new Error('source, account_id, period_start, period_end 가 필요합니다.');

  const startMonth = start.slice(0, 7);
  const endMonth = end.slice(0, 7);
  const monthList: string[] = [];
  const mc = new Date(startMonth + '-01T00:00:00Z');
  const me = new Date(endMonth + '-01T00:00:00Z');
  while (mc <= me) {
    monthList.push(mc.toISOString().slice(0, 7));
    mc.setUTCMonth(mc.getUTCMonth() + 1);
  }
  const monthResults = await Promise.all(monthList.map(ym => data.list(`txn:${ym}:`, 1000)));
  const userTxns: Transaction[] = [];
  for (const rows of monthResults) {
    for (const r of rows) {
      const t = r.value as Transaction;
      if (!t || t.date < start || t.date > end) continue;
      if (t.from_account === accountId || t.to_account === accountId) userTxns.push(t);
    }
  }

  const matched = new Set<string>();
  const missing: any[] = [];
  const mismatched: any[] = [];

  for (const bt of bankTxns) {
    const btDate = bt.date as string;
    const btAmt = Math.abs(Number(bt.amount));
    const btType = (bt.type as string) || 'expense';
    const bankOutflow = btType !== 'income';

    const cand = userTxns.find(t => {
      if (matched.has(t.id)) return false;
      const userOutflow = t.from_account === accountId;
      if (userOutflow !== bankOutflow) return false;
      if (Math.abs(daysBetween(t.date, btDate)) > 1) return false;
      const diff = Math.abs(t.amount - btAmt);
      return diff <= Math.max(50, btAmt * 0.05);
    });

    if (!cand) missing.push(bt);
    else if (cand.amount !== btAmt) {
      mismatched.push({ user_txn_id: cand.id, user_amount: cand.amount, bank_amount: btAmt, bank_txn: bt });
      matched.add(cand.id);
    } else matched.add(cand.id);
  }

  let addedCount = 0;
  let queuedCount = 0;

  for (const bt of missing) {
    if (autoAdd) {
      const id = newId();
      const ym = (bt.date as string).slice(0, 7);
      const btType = (bt.type as string) || 'expense';
      const amt = Math.abs(Number(bt.amount));
      const newTxn: Transaction = {
        id, type: btType as Transaction['type'], amount: amt,
        from_account: btType === 'income' ? undefined : accountId,
        to_account: btType === 'income' ? accountId : undefined,
        category: bt.category, merchant: bt.merchant,
        memo: (bt.memo || '') + ` [auto from ${source}]`,
        date: bt.date, created_at: now(),
      };
      await data.set(`txn:${ym}:${id}`, newTxn);
      await adjustBalance(data, accountId, btType === 'income' ? +amt : -amt);
      addedCount++;
    } else {
      const pid = newId();
      const amt = Math.abs(Number(bt.amount));
      await data.set(`pending:${pid}`, {
        id: pid, kind: 'missing_txn', status: 'pending', created_at: now(),
        data: {
          source, account_id: accountId, bank_txn: bt,
          question: `${bt.date} ${bt.merchant || '?'} ${fmt(amt)}원 — 기록 없음. 누락인지 확인 필요.`,
        },
      });
      queuedCount++;
    }
  }

  for (const mm of mismatched) {
    const pid = newId();
    await data.set(`pending:${pid}`, {
      id: pid, kind: 'amount_mismatch', status: 'pending', created_at: now(),
      data: {
        ...mm,
        question: `${mm.bank_txn.date} ${mm.bank_txn.merchant || '?'}: 기록 ${fmt(mm.user_amount)}원, 실제 승인 ${fmt(mm.bank_amount)}원. 어느 쪽이 맞는지 확인 필요.`,
      },
    });
    queuedCount++;
  }

  const lead = `대조 결과 — 일치 ${matched.size}건, 누락 ${missing.length}건${autoAdd ? ` (자동 추가 ${addedCount})` : ''}, 금액 불일치 ${mismatched.length}건. ${queuedCount > 0 ? `pending 큐에 ${queuedCount}건 추가됨.` : ''}`.trim();

  return {
    text: lead,
    matched_count: matched.size,
    added_count: addedCount,
    queued_count: queuedCount,
    mismatched_count: mismatched.length,
  };
}

function daysBetween(a: string, b: string): number {
  return (Date.parse(a) - Date.parse(b)) / 86400000;
}

async function resolvePending(args: any, data: DataAPI) {
  const pid = args.pending_id as string;
  const action = args.action as string;
  if (!pid || !action) throw new Error('pending_id, action 이 필요합니다.');
  const pending = (await data.get(`pending:${pid}`)) as Pending | null;
  if (!pending) throw new Error(`pending_id 가 존재하지 않습니다: ${pid}`);

  if (action === 'accept' && pending.kind === 'missing_txn') {
    const bt = pending.data.bank_txn;
    const accountId = pending.data.account_id;
    const btType = (bt.type as string) || 'expense';
    const amt = Math.abs(Number(bt.amount));
    const id = newId();
    const ym = bt.date.slice(0, 7);
    await data.set(`txn:${ym}:${id}`, {
      id, type: btType, amount: amt,
      from_account: btType === 'income' ? undefined : accountId,
      to_account: btType === 'income' ? accountId : undefined,
      category: bt.category, merchant: bt.merchant, memo: bt.memo,
      date: bt.date, created_at: now(),
    });
    await adjustBalance(data, accountId, btType === 'income' ? +amt : -amt);
  } else if (action === 'correct' && pending.kind === 'amount_mismatch') {
    const userTxnId = pending.data.user_txn_id as string;
    const newAmount = Number(args.corrected_amount ?? pending.data.bank_amount);
    const ym = (pending.data.bank_txn.date as string).slice(0, 7);
    const t = (await data.get(`txn:${ym}:${userTxnId}`)) as Transaction | null;
    if (t) {
      const delta = newAmount - t.amount;
      t.amount = newAmount;
      if (args.corrected_category) t.category = args.corrected_category;
      await data.set(`txn:${ym}:${userTxnId}`, t);
      if (t.from_account) await adjustBalance(data, t.from_account, -delta);
      if (t.to_account) await adjustBalance(data, t.to_account, +delta);
    }
  } else if (action === 'explain') {
    pending.data.answer = args.answer;
  }
  pending.status = 'resolved';
  await data.set(`pending:${pid}`, pending);
  return { text: `처리 완료.`, status: 'resolved' };
}

async function addRecurring(args: any, data: DataAPI) {
  const name = args.name as string;
  const amount = Number(args.amount);
  const kind = args.kind as Recurring['kind'];
  if (!name || !amount || !kind) throw new Error('name, amount, kind 가 필요합니다.');
  if (!['expense', 'income', 'sinking_fund'].includes(kind)) {
    throw new Error('kind 는 expense | income | sinking_fund 중 하나여야 합니다.');
  }
  const id = newId();
  await data.set(`recurring:${id}`, {
    id, name, amount, kind,
    cadence: args.cadence,
    day_of_month: args.day_of_month,
    category: args.category,
    account_id: args.account_id,
    created_at: now(),
  });
  const tail = kind === 'sinking_fund'
    ? `연 ${fmt(amount)}원 → 매월 ${fmt(amount / 12)}원 할당.`
    : kind === 'expense' ? `매월 ${fmt(amount)}원 할당.` : `월 ${fmt(amount)}원 수입으로 등록.`;
  return { text: `${name} 등록. ${tail}`, id };
}

// 거래의 잔고 영향을 적용/되돌리기 위한 단일 진입점. sign=+1 적용, sign=-1 되돌림.
async function applyTxnBalance(data: DataAPI, txn: Transaction, sign: 1 | -1) {
  const amt = txn.amount * sign;
  if (txn.type === 'expense') {
    if (txn.from_account) {
      const found = await loadAccountOrDebt(data, txn.from_account);
      if (found?.kind === 'debt') await adjustBalance(data, txn.from_account, +amt);
      else await adjustBalance(data, txn.from_account, -amt);
    }
  } else if (txn.type === 'income') {
    if (txn.to_account) {
      const found = await loadAccountOrDebt(data, txn.to_account);
      if (found?.kind === 'debt') await adjustBalance(data, txn.to_account, -amt);
      else await adjustBalance(data, txn.to_account, +amt);
    }
  } else if (txn.type === 'transfer') {
    if (txn.from_account) await adjustBalance(data, txn.from_account, -amt);
    if (txn.to_account) await adjustBalance(data, txn.to_account, +amt);
  } else if (txn.type === 'card_payment') {
    if (txn.from_account) await adjustBalance(data, txn.from_account, -amt);
    if (txn.to_account) await adjustBalance(data, txn.to_account, -amt);
  }
}

async function updateEntry(args: any, data: DataAPI) {
  const entityType = args.entity_type as string;
  const id = args.id as string | undefined;
  const patch = (args.patch || {}) as Record<string, any>;
  if (!entityType) throw new Error('entity_type 이 필요합니다.');
  if (!patch || Object.keys(patch).length === 0) throw new Error('patch 가 비어 있습니다.');

  if (entityType === 'goal') {
    const cur = (await data.get('goal')) as Goal | null;
    if (!cur) throw new Error('goal 이 등록되어 있지 않습니다. setup_state 로 먼저 등록하세요.');
    const next = { ...cur, ...patch };
    await data.set('goal', next);
    return { text: `목표 갱신: ${fmt(next.amount)}원 by ${next.deadline}.`, entity: next };
  }

  if (!id) throw new Error(`${entityType} 수정에는 id 가 필요합니다.`);

  if (entityType === 'account' || entityType === 'debt') {
    const key = `${entityType}:${id}`;
    const cur = await data.get(key);
    if (!cur) throw new Error(`${key} 가 존재하지 않습니다.`);
    const next = { ...cur, ...patch };
    if (patch.balance !== undefined) next.balance = Number(patch.balance);
    await data.set(key, next);
    return { text: `${next.name || id} 갱신 완료.`, entity: next };
  }

  if (entityType === 'recurring') {
    const key = `recurring:${id}`;
    const cur = await data.get(key);
    if (!cur) throw new Error(`${key} 가 존재하지 않습니다.`);
    const next = { ...cur, ...patch };
    if (patch.amount !== undefined) next.amount = Number(patch.amount);
    await data.set(key, next);
    return { text: `${next.name || id} 정기 항목 갱신.`, entity: next };
  }

  if (entityType === 'transaction') {
    const month = args.month as string;
    if (!month) throw new Error('transaction 수정에는 month (YYYY-MM) 가 필요합니다.');
    const key = `txn:${month}:${id}`;
    const cur = (await data.get(key)) as Transaction | null;
    if (!cur) throw new Error(`${key} 가 존재하지 않습니다.`);
    // 옛 영향 되돌리고
    await applyTxnBalance(data, cur, -1);
    const next: Transaction = { ...cur, ...patch };
    if (patch.amount !== undefined) next.amount = Number(patch.amount);
    if (patch.original_amount !== undefined) next.original_amount = Number(patch.original_amount);
    // 날짜가 바뀌면 월별 키도 옮긴다
    const newMonth = (next.date || cur.date).slice(0, 7);
    if (newMonth !== month) {
      await data.delete(key);
      await data.set(`txn:${newMonth}:${id}`, next);
    } else {
      await data.set(key, next);
    }
    // 새 영향 다시 적용
    await applyTxnBalance(data, next, +1);
    return { text: `거래 ${id} 갱신: ${fmt(next.amount)}원. 잔고 자동 보정됨.`, entity: next };
  }

  if (entityType === 'voucher_use') {
    const voucherName = args.voucher_name as string;
    if (!voucherName) throw new Error('voucher_use 수정에는 voucher_name 이 필요합니다.');
    const key = `voucher:${voucherName}:${id}`;
    const cur = await data.get(key);
    if (!cur) throw new Error(`${key} 가 존재하지 않습니다.`);
    const oldAmount = Number(cur.amount_used);
    const next = { ...cur, ...patch };
    if (patch.amount_used !== undefined) next.amount_used = Number(patch.amount_used);
    await data.set(key, next);
    // 바우처 잔액 보정: 옛 금액 복원 + 새 금액 차감
    const delta = oldAmount - Number(next.amount_used);
    if (delta !== 0) {
      const balKey = `voucher_balance:${voucherName}`;
      const bal = (await data.get(balKey)) as { balance: number } | null;
      const newBal = (bal?.balance ?? 0) + delta;
      await data.set(balKey, { balance: newBal });
    }
    return { text: `${voucherName} 사용 기록 갱신 — 잔액 보정 완료.`, entity: next };
  }

  throw new Error(`알 수 없는 entity_type: ${entityType}`);
}

async function deleteEntry(args: any, data: DataAPI) {
  const entityType = args.entity_type as string;
  const id = args.id as string | undefined;
  if (!entityType) throw new Error('entity_type 이 필요합니다.');

  if (entityType === 'goal') {
    const ok = await data.delete('goal');
    return { text: ok ? '목표 삭제 완료.' : '삭제할 목표가 없습니다.', deleted: ok };
  }

  if (!id) throw new Error(`${entityType} 삭제에는 id 가 필요합니다.`);

  if (entityType === 'account' || entityType === 'debt') {
    const key = `${entityType}:${id}`;
    const ok = await data.delete(key);
    return {
      text: ok
        ? `${key} 삭제 완료. 묶인 과거 거래의 잔고 정합성은 보장되지 않습니다.`
        : `${key} 가 존재하지 않습니다.`,
      deleted: ok,
    };
  }

  if (entityType === 'recurring') {
    const key = `recurring:${id}`;
    const ok = await data.delete(key);
    return {
      text: ok ? `정기 항목 ${id} 삭제 — 다음 달부터 할당 제외.` : `recurring:${id} 가 존재하지 않습니다.`,
      deleted: ok,
    };
  }

  if (entityType === 'transaction') {
    const month = args.month as string;
    if (!month) throw new Error('transaction 삭제에는 month (YYYY-MM) 가 필요합니다.');
    const key = `txn:${month}:${id}`;
    const cur = (await data.get(key)) as Transaction | null;
    if (!cur) return { text: `${key} 가 존재하지 않습니다.`, deleted: false };
    await applyTxnBalance(data, cur, -1);
    await data.delete(key);
    return { text: `거래 ${id} (${fmt(cur.amount)}원) 삭제 — 잔고 되돌림 완료.`, deleted: true };
  }

  if (entityType === 'voucher_use') {
    const voucherName = args.voucher_name as string;
    if (!voucherName) throw new Error('voucher_use 삭제에는 voucher_name 이 필요합니다.');
    const key = `voucher:${voucherName}:${id}`;
    const cur = await data.get(key);
    if (!cur) return { text: `${key} 가 존재하지 않습니다.`, deleted: false };
    const amt = Number(cur.amount_used);
    const balKey = `voucher_balance:${voucherName}`;
    const bal = (await data.get(balKey)) as { balance: number } | null;
    await data.set(balKey, { balance: (bal?.balance ?? 0) + amt });
    await data.delete(key);
    return { text: `${voucherName} 사용 ${fmt(amt)}원 취소 — 잔액 복원 완료.`, deleted: true };
  }

  throw new Error(`알 수 없는 entity_type: ${entityType}`);
}

function scroogeNag(state: any, intensity: string): string[] {
  const lines: string[] = [];
  const harsh = intensity === '매섭게';
  const soft = intensity === '부드럽게';

  if (state.spendable < 0) {
    lines.push(harsh
      ? `쓸 수 있는 돈이 ${fmt(Math.abs(state.spendable))}원 부족합니다. 즉시 조정이 필요합니다.`
      : soft ? `쓸 수 있는 돈이 ${fmt(Math.abs(state.spendable))}원 부족합니다.`
      : `쓸 수 있는 돈이 ${fmt(Math.abs(state.spendable))}원 부족합니다. 조정이 필요합니다.`);
  }

  // 월 페이스 경고 — 반드시 projection 기반.
  const p = state.pace_vs_goal;
  const fc = state.month_forecast;
  if (p && p.month_on_track === false) {
    const shortfall = p.month_shortfall;
    const sfNote = fc && fc.sinking_fund_monthly_commit > 0
      ? ` (sinking_fund 월 ${fmt(fc.sinking_fund_monthly_commit)}원 [연 ${fmt(fc.sinking_fund_annual_total)}원의 1/12] 약속 지출로 포함)`
      : '';
    lines.push(
      `이번 달 예상 최종 net ${fmt(p.projected_month_pl)}원${sfNote}. 목표 페이스 ${fmt(p.needed_per_month)}원에 ${fmt(shortfall)}원 부족. 남은 ${fc?.days_remaining ?? '?'}일 조정 필요.`
    );
  } else if (p && p.month_on_track === true && fc) {
    const sfNote = fc.sinking_fund_monthly_commit > 0
      ? ` (sinking_fund 월 ${fmt(fc.sinking_fund_monthly_commit)}원 [연 ${fmt(fc.sinking_fund_annual_total)}원의 1/12] 차감 후)`
      : '';
    lines.push(`이번 달 예상 최종 net ${fmt(p.projected_month_pl)}원, 목표 페이스 ${fmt(p.needed_per_month)}원 충족${sfNote}.`);
  }
  if (p && p.cumulative_on_track === false) {
    lines.push(`누적 진척이 일정 대비 미달. 현재 순자산 ${fmt(p.current_net_worth)}원, 목표 ${fmt(state.goal?.amount ?? 0)}원.`);
  }

  // 예측 추정 안내.
  if (fc?.estimation_notes?.length) {
    for (const note of fc.estimation_notes) lines.push(note);
  }

  const pending = state.pending?.length || 0;
  if (pending > 0) lines.push(`미해결 항목 ${pending}건이 처리 대기 중입니다.`);

  const exp = state.this_month_summary?.total_expense || 0;
  const inc = state.this_month_summary?.total_income || 0;
  const cp = state.this_month_summary?.total_card_payment || 0;
  if (inc > 0 && exp > inc) {
    lines.push(`이번 달 발생주의 적자 ${fmt(exp - inc)}원 (지출 ${fmt(exp)} 대 수입 ${fmt(inc)}). 카드값 결제 ${fmt(cp)}원은 P&L 무관 — 별도.`);
  }

  const cats = state.this_month_summary?.by_category || {};
  const total = (Object.values(cats) as number[]).reduce((s, v) => s + v, 0);
  const sorted = Object.entries(cats).sort((a: any, b: any) => b[1] - a[1]);
  const top = sorted[0];
  if (top && total > 0 && ((top[1] as number) / total) > 0.5) {
    lines.push(`${top[0]} 카테고리가 전체 지출의 ${Math.round(((top[1] as number) / total) * 100)}% 를 차지합니다. 비중을 점검해 보세요.`);
  }

  if (lines.length === 0) {
    lines.push(harsh ? '현재 큰 경고는 없습니다. 페이스 유지가 필요합니다.' : '현재 큰 경고는 없습니다.');
  }
  return lines;
}

async function getState(args: any, data: DataAPI) {
  const month = (args.month as string) || thisMonth();
  const isCurrentMonth = month === thisMonth();

  const [accounts, debts, recurrings, pendings, voucherBalances, goalRaw, monthTxns, settingsRaw] = await Promise.all([
    data.list('account:'),
    data.list('debt:'),
    data.list('recurring:'),
    data.list('pending:'),
    data.list('voucher_balance:'),
    data.get('goal'),
    data.list(`txn:${month}:`, 1000),
    data.get('__settings'),
  ]);

  const allTxns = monthTxns.map(r => r.value as Transaction).filter(Boolean);

  // P&L 집계 — 발생주의. card_payment 는 P&L 영향 없음, 별도 노출.
  const byCategory: Record<string, number> = {};
  let totalExpense = 0, totalIncome = 0, totalCardPayment = 0;
  for (const t of allTxns) {
    if (t.type === 'expense') {
      totalExpense += t.amount;
      const c = t.category || '미분류';
      byCategory[c] = (byCategory[c] || 0) + t.amount;
    } else if (t.type === 'income') {
      totalIncome += t.amount;
    } else if (t.type === 'card_payment') {
      totalCardPayment += t.amount;
    }
  }
  const currentMonthPl = totalIncome - totalExpense;

  const recurringItems = recurrings.map(r => r.value as Recurring).filter(Boolean);
  const allocations: Array<{ name: string; monthly: number; kind: string }> = [];
  let totalAllocated = 0;
  let sinkingFundMonthlyCommit = 0;
  let sinkingFundAnnualTotal = 0;
  for (const r of recurringItems) {
    if (r.kind === 'sinking_fund') {
      const m = Math.round(r.amount / 12);
      allocations.push({ name: r.name, monthly: m, kind: 'sinking_fund' });
      totalAllocated += m;
      sinkingFundMonthlyCommit += m;
      sinkingFundAnnualTotal += r.amount;
    } else if (r.kind === 'expense') {
      allocations.push({ name: r.name, monthly: r.amount, kind: 'expense' });
      totalAllocated += r.amount;
    }
  }

  const totalAssets = accounts.reduce((s, r) => s + ((r.value?.balance) || 0), 0);
  const totalDebt = debts.reduce((s, r) => s + ((r.value?.balance) || 0), 0);
  const netWorth = totalAssets - totalDebt;
  const spendable = totalAssets - totalDebt - totalAllocated;

  // month_forecast — 이번 달에 한해서만 의미 있음.
  let monthForecast: any = null;
  if (isCurrentMonth) {
    const todayDate = new Date();
    const todayDay = todayDate.getUTCDate();
    const year = todayDate.getUTCFullYear();
    const mIdx = todayDate.getUTCMonth();
    const daysInMonth = new Date(Date.UTC(year, mIdx + 1, 0)).getUTCDate();
    const daysRemaining = Math.max(0, daysInMonth - todayDay);

    // 이번 달 거래에서 이미 처리된 recurring_id 집합.
    const processedRecurringIds = new Set(
      allTxns.map(t => t.recurring_id).filter(Boolean) as string[]
    );

    const upcoming: Array<{
      id: string; name: string; amount: number; kind: string;
      day_of_month?: number; estimated: boolean; base_amount?: number;
    }> = [];
    let proratedCount = 0;
    let upcomingExpense = 0, upcomingIncome = 0;

    for (const rec of recurringItems) {
      if (rec.kind === 'sinking_fund') continue;  // sinking_fund 는 별도 라인으로 처리.
      if (processedRecurringIds.has(rec.id)) continue;  // 이미 이번 달에 처리됨.

      if (rec.day_of_month) {
        // 정확한 날짜 기반 — 이미 매칭 안 됐으니 처리 예정 또는 입력 누락. 보수적으로 차감에 포함.
        upcoming.push({
          id: rec.id, name: rec.name, amount: rec.amount, kind: rec.kind,
          day_of_month: rec.day_of_month, estimated: false,
        });
        if (rec.kind === 'expense') upcomingExpense += rec.amount;
        else if (rec.kind === 'income') upcomingIncome += rec.amount;
      } else {
        // day_of_month 없음 → 비례 배분.
        const prorated = Math.round(rec.amount * daysRemaining / daysInMonth);
        upcoming.push({
          id: rec.id, name: rec.name, amount: prorated, kind: rec.kind,
          estimated: true, base_amount: rec.amount,
        });
        if (rec.kind === 'expense') upcomingExpense += prorated;
        else if (rec.kind === 'income') upcomingIncome += prorated;
        proratedCount++;
      }
    }

    const projectedOutflow = upcomingExpense + sinkingFundMonthlyCommit;
    const projectedInflow = upcomingIncome;
    const projectedMonthEndPl = currentMonthPl + projectedInflow - projectedOutflow;
    const projectedMonthEndNetWorth = netWorth + projectedInflow - projectedOutflow;

    const estimationNotes: string[] = [];
    if (proratedCount > 0) {
      estimationNotes.push(
        `정기 항목 ${proratedCount}건이 day_of_month 미설정 — 비례 배분으로 추정. 정확한 날짜가 있으면 add_recurring 또는 update_entry 로 day_of_month 를 채워주세요.`
      );
    }
    const missedRecurring = upcoming.filter(u => u.day_of_month && u.day_of_month <= todayDay);
    if (missedRecurring.length > 0) {
      estimationNotes.push(
        `이번 달 처리 예정일(${missedRecurring.map(m => m.day_of_month).join(', ')}) 이 지났는데 recurring_id 매칭 거래가 없는 항목 ${missedRecurring.length}건. 이미 처리됐다면 update_entry 로 해당 거래에 recurring_id 를 채워주세요.`
      );
    }

    monthForecast = {
      today: todayDate.toISOString().slice(0, 10),
      days_in_month: daysInMonth,
      days_remaining: daysRemaining,
      upcoming_recurring: upcoming,
      sinking_fund_monthly_commit: sinkingFundMonthlyCommit,
      sinking_fund_annual_total: sinkingFundAnnualTotal,
      projected_outflow: projectedOutflow,
      projected_inflow: projectedInflow,
      projected_month_end_pl: projectedMonthEndPl,
      projected_month_end_net_worth: projectedMonthEndNetWorth,
      estimation_notes: estimationNotes,
    };
  }

  // pace_vs_goal — 월간 페이스(projection 기반) + 전체 누적 페이스 둘 다 노출.
  const goal = goalRaw as Goal | null;
  let pace: any = null;
  if (goal) {
    const end = Date.parse(goal.deadline + 'T00:00:00Z');
    const monthsLeft = Math.max(1, Math.round((end - Date.now()) / (30 * 86400000)));
    const remaining = Math.max(0, goal.amount - netWorth);
    const neededPerMonth = Math.round(remaining / monthsLeft);
    const start = Date.parse(goal.created_at);
    const monthsTotal = Math.max(1, Math.round((end - start) / (30 * 86400000)));
    const expectedSavings = goal.amount * (1 - monthsLeft / monthsTotal);

    const projectedMonthPl = monthForecast ? monthForecast.projected_month_end_pl : currentMonthPl;
    const monthShortfall = neededPerMonth - projectedMonthPl;

    pace = {
      months_left: monthsLeft,
      remaining,
      needed_per_month: neededPerMonth,
      current_net_worth: netWorth,
      current_month_pl: currentMonthPl,
      projected_month_pl: projectedMonthPl,
      month_on_track: projectedMonthPl >= neededPerMonth,
      month_shortfall: monthShortfall,                    // 양수 = 부족, 음수 = 여유
      cumulative_on_track: netWorth >= expectedSavings,   // 누적 진척이 일정 대비 OK?
    };
  }

  const voucherBalanceMap: Record<string, number> = {};
  for (const r of voucherBalances) {
    const name = r.key.replace('voucher_balance:', '');
    voucherBalanceMap[name] = (r.value?.balance) ?? 0;
  }

  const pendingItems = pendings
    .map(r => r.value as Pending)
    .filter(p => p && p.status === 'pending');

  const recent = [...allTxns]
    .sort((a, b) => b.date.localeCompare(a.date) || b.created_at.localeCompare(a.created_at))
    .slice(0, 10);

  const result = {
    month,
    goal,
    accounts: accounts.map(r => r.value),
    debts: debts.map(r => r.value),
    net_worth: netWorth,
    total_assets: totalAssets,
    total_debt: totalDebt,
    spendable,
    total_allocated: totalAllocated,
    allocations,
    this_month_summary: {
      total_expense: totalExpense,         // 발생주의 — 새로 발생한 지출
      total_income: totalIncome,           // 발생주의 — 새로 들어온 수입
      total_card_payment: totalCardPayment, // 카드값 결제. P&L 영향 없음 (이전 지출의 정산). 페이스 계산에 합산 금지.
      current_month_pl: currentMonthPl,    // = total_income - total_expense (발생주의 기준)
      by_category: byCategory,
    },
    month_forecast: monthForecast,
    pace_vs_goal: pace,
    recent_transactions: recent,
    pending: pendingItems,
    voucher_balances: voucherBalanceMap,
    recurring: recurringItems,
  };

  const intensity = (settingsRaw as any)?.nag_intensity || '보통';
  return { ...result, nag: scroogeNag(result, intensity) };
}

async function listTransactions(args: any, data: DataAPI) {
  const month = args.month as string | undefined;
  const dateFrom = args.date_from as string | undefined;     // YYYY-MM-DD
  const dateTo = args.date_to as string | undefined;
  const type = args.type as string | undefined;
  const category = args.category as string | undefined;
  const merchantQuery = (args.merchant_query as string | undefined)?.toLowerCase();
  const fromAccount = args.from_account as string | undefined;
  const toAccount = args.to_account as string | undefined;
  const recurringId = args.recurring_id as string | undefined;
  const limit = Math.min(Math.max(1, Math.floor(Number(args.limit) || 100)), 500);
  const cursor = args.cursor as string | undefined;

  // 조회할 월 prefix 목록 결정.
  const months: string[] = [];
  if (dateFrom && dateTo) {
    const startY = Number(dateFrom.slice(0, 4));
    const startM = Number(dateFrom.slice(5, 7));
    const endY = Number(dateTo.slice(0, 4));
    const endM = Number(dateTo.slice(5, 7));
    let y = startY, m = startM;
    while (y < endY || (y === endY && m <= endM)) {
      months.push(`${y}-${String(m).padStart(2, '0')}`);
      m++;
      if (m > 12) { m = 1; y++; }
      if (months.length > 60) break;  // 5년 cap — 폭주 방지.
    }
  } else if (month) {
    months.push(month);
  } else {
    months.push(thisMonth());
  }

  // 월별 끌어오기. 한 달이 cap (1000) 닿으면 warning.
  const warnings: string[] = [];
  const allTxns: Transaction[] = [];
  const monthResults = await Promise.all(months.map(ym => data.list(`txn:${ym}:`, 1000)));
  monthResults.forEach((rows, i) => {
    if (rows.length >= 1000) {
      warnings.push(`${months[i]} 월 거래가 데이터 cap (1000) 에 닿음 — 일부 누락 가능. 해당 월 단독 조회 + 더 좁은 필터 권장.`);
    }
    for (const r of rows) {
      if (r.value) allTxns.push(r.value as Transaction);
    }
  });

  // 필터 적용.
  const filtered = allTxns.filter(t => {
    if (type && t.type !== type) return false;
    if (category && t.category !== category) return false;
    if (merchantQuery && !(t.merchant || '').toLowerCase().includes(merchantQuery)) return false;
    if (fromAccount && t.from_account !== fromAccount) return false;
    if (toAccount && t.to_account !== toAccount) return false;
    if (recurringId && t.recurring_id !== recurringId) return false;
    if (dateFrom && t.date < dateFrom) return false;
    if (dateTo && t.date > dateTo) return false;
    return true;
  });

  // 시간 역순 정렬 (최신 거래 먼저).
  filtered.sort((a, b) => b.date.localeCompare(a.date) || b.created_at.localeCompare(a.created_at));

  // 집계 — 필터 만족 전체 기준 (cap 무관, 항상 정확).
  const totalCountInFilter = filtered.length;
  const totalAmount = filtered.reduce((s, t) => s + t.amount, 0);

  // 카테고리별 집계 — expense 거래에 한해.
  const byCategory: Record<string, number> = {};
  for (const t of filtered) {
    if (t.type === 'expense') {
      const c = t.category || '미분류';
      byCategory[c] = (byCategory[c] || 0) + t.amount;
    }
  }

  // 타입별 집계.
  const byType: Record<string, { count: number; sum: number }> = {};
  for (const t of filtered) {
    if (!byType[t.type]) byType[t.type] = { count: 0, sum: 0 };
    byType[t.type].count++;
    byType[t.type].sum += t.amount;
  }

  // Cursor pagination — 이전 응답의 마지막 txn id 이후로 자름.
  let startIdx = 0;
  if (cursor) {
    const i = filtered.findIndex(t => t.id === cursor);
    if (i >= 0) startIdx = i + 1;
  }
  const page = filtered.slice(startIdx, startIdx + limit);
  const hasMore = (startIdx + limit) < filtered.length;
  const nextCursor = hasMore && page.length > 0 ? page[page.length - 1].id : undefined;

  // 응답 텍스트.
  const scopeNote = months.length === 1 ? months[0] : `${months[0]} ~ ${months[months.length - 1]} (${months.length}개월)`;
  const text = `조회 ${scopeNote} — ${totalCountInFilter}건, 합 ${fmt(totalAmount)}원${
    page.length < totalCountInFilter ? ` (이번 응답 ${page.length}건${hasMore ? ', has_more' : ''})` : ''
  }${warnings.length ? ` · ⚠ ${warnings.length}건 경고` : ''}.`;

  return {
    text,
    transactions: page,
    count: page.length,
    total_count_in_filter: totalCountInFilter,
    total_amount: totalAmount,
    by_category: byCategory,
    by_type: byType,
    has_more: hasMore,
    next_cursor: nextCursor,
    scope: { months_scanned: months, ...(dateFrom ? { date_from: dateFrom } : {}), ...(dateTo ? { date_to: dateTo } : {}) },
    warnings: warnings.length ? warnings : undefined,
  };
}

async function dailyBriefing(data: DataAPI) {
  const state: any = await getState({}, data);

  const body = (state.nag || []).slice(0, 2).join(' · ');
  if (!body) return { notifications: [] };

  return {
    notifications: [{
      id: `daily-${today()}`,
      title: `오늘의 가계부 알림`,
      body,
      url: '/board',
    }],
  };
}

async function renderBoard(args: any, data: DataAPI) {
  const month = (args.month as string) || thisMonth();
  const state: any = await getState({ month }, data);

  const byCat = state.this_month_summary?.by_category || {};
  const catRows = Object.entries(byCat)
    .sort((a, b) => (b[1] as number) - (a[1] as number))
    .map(([c, v]) => `<tr><td>${escapeHtml(c)}</td><td style="text-align:right">${fmt(v as number)}</td></tr>`)
    .join('');

  const p = state.pace_vs_goal;
  const goalBlock = state.goal ? `
    <div><strong>목표</strong> ${fmt(state.goal.amount)} by ${state.goal.deadline}
    <br><small style="color:#888">${escapeHtml(state.goal.rationale || '')}</small>
    <br>순자산 ${fmt(state.net_worth)} (${Math.round((state.net_worth / state.goal.amount) * 100)}%)
    ${p ? `<br><small style="color:${p.cumulative_on_track ? '#7c7' : '#e77'}">${p.cumulative_on_track ? '✓ 누적 진척 OK' : `✗ 누적 진척 미달 (월 ${fmt(p.needed_per_month)}원 페이스 필요)`}</small>` : ''}
    </div>` : '<div style="color:#888">목표 미설정.</div>';

  const fc = state.month_forecast;
  const forecastBlock = fc ? (() => {
    const projPl = fc.projected_month_end_pl;
    const projColor = projPl >= 0 ? '#7c7' : '#e77';
    const needed = p?.needed_per_month ?? 0;
    const paceLine = p ? (
      p.month_on_track
        ? `<span style="color:#7c7">✓ 목표 페이스 ${fmt(needed)}원 충족 (여유 ${fmt(-p.month_shortfall)}원)</span>`
        : `<span style="color:#e77">✗ 목표 페이스 ${fmt(needed)}원에 ${fmt(p.month_shortfall)}원 부족</span>`
    ) : '';
    const upcomingRows = (fc.upcoming_recurring || [])
      .sort((a: any, b: any) => (a.day_of_month ?? 99) - (b.day_of_month ?? 99))
      .map((u: any) => {
        const day = u.day_of_month ? `${u.day_of_month}일` : '날짜미정';
        const sign = u.kind === 'income' ? '+' : '−';
        const est = u.estimated ? ` <small style="color:#888">(추정, 정가 ${fmt(u.base_amount)})</small>` : '';
        return `<tr><td style="color:#888;width:50px">${day}</td><td>${escapeHtml(u.name)}${est}</td><td style="text-align:right">${sign}${fmt(u.amount)}</td></tr>`;
      }).join('');
    const sfLine = fc.sinking_fund_monthly_commit > 0
      ? `<tr><td style="color:#888">매월</td><td>sinking_fund 합 <small style="color:#888">(연 ${fmt(fc.sinking_fund_annual_total)}원의 1/12)</small></td><td style="text-align:right">−${fmt(fc.sinking_fund_monthly_commit)}</td></tr>`
      : '';
    const notesBlock = (fc.estimation_notes || []).length
      ? `<div style="font-size:11px;color:#c8a85a;margin-top:8px;line-height:1.5">${fc.estimation_notes.map((n: string) => `⚠ ${escapeHtml(n)}`).join('<br>')}</div>`
      : '';
    return `
    <div class="col" style="margin-bottom:12px">
      <h2>이번 달 예측 (D-${fc.days_remaining})</h2>
      <div style="font-size:12px;color:#aaa;margin-bottom:6px">
        현재 P&L ${fmt(state.this_month_summary.current_month_pl)}원
        ${fc.projected_inflow > 0 ? ` + 예상 수입 ${fmt(fc.projected_inflow)}원` : ''}
        − 예상 지출 ${fmt(fc.projected_outflow)}원
      </div>
      <div class="big" style="color:${projColor}">${projPl >= 0 ? '+' : ''}${fmt(projPl)}</div>
      <div style="font-size:12px;margin-top:4px">${paceLine}</div>
      ${(upcomingRows || sfLine) ? `
      <details style="margin-top:10px">
        <summary style="cursor:pointer;font-size:12px;color:#888">남은 정기 항목 ${(fc.upcoming_recurring || []).length}건 ${fc.sinking_fund_monthly_commit > 0 ? '+ sinking_fund' : ''}</summary>
        <table style="margin-top:6px">${upcomingRows}${sfLine}</table>
      </details>` : ''}
      ${notesBlock}
    </div>`;
  })() : '';

  const pendingBlock = state.pending?.length ? `
    <div style="background:#3a2020;padding:8px;border-radius:6px;margin-bottom:12px">
      <strong>미해결 ${state.pending.length}건</strong>
      <ul style="margin:6px 0 0;padding-left:18px;font-size:12px">
        ${state.pending.slice(0, 5).map((p: any) => `<li>${escapeHtml(p.data?.question || p.kind)}</li>`).join('')}
      </ul>
    </div>` : '';

  const voucherBlock = Object.keys(state.voucher_balances || {}).length ? `
    <h2>바우처 장부</h2>
    <table>${Object.entries(state.voucher_balances).map(([n, b]) => `<tr><td>${escapeHtml(n)}</td><td style="text-align:right">${fmt(b as number)}</td></tr>`).join('')}</table>` : '';

  const nagBlock = state.nag?.length ? `
    <div style="background:#2a2a3a;padding:10px;border-left:3px solid #f4b942;border-radius:4px;margin-bottom:12px;font-size:13px;line-height:1.6">
      <strong style="color:#f4b942">현재 상태 요약</strong><br>
      ${state.nag.map((line: string) => `· ${escapeHtml(line)}`).join('<br>')}
    </div>` : '';

  return {
    html: `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
body{font-family:-apple-system,sans-serif;padding:12px;background:#1a1a1a;color:#eee;margin:0}
h2{margin:10px 0 6px;font-size:11px;color:#888;text-transform:uppercase;letter-spacing:1px}
table{width:100%;border-collapse:collapse;font-size:13px}
td{padding:4px 6px;border-bottom:1px solid #2a2a2a}
.big{font-size:22px;font-weight:bold;color:#f4b942}
.row{display:flex;gap:10px;margin-bottom:10px}
.col{flex:1;background:#222;padding:10px;border-radius:8px}
input[type=month]{background:#333;color:#eee;border:1px solid #444;padding:4px 8px;border-radius:4px;margin-bottom:10px}
</style></head><body>
<input type="month" id="m" value="${month}">
${nagBlock}
<div class="row">
  <div class="col"><h2>쓸 수 있는 돈</h2><div class="big">${fmt(state.spendable)}</div>
    <small style="color:#888">자산 ${fmt(state.total_assets)} − 부채 ${fmt(state.total_debt)} − 할당 ${fmt(state.total_allocated)}</small></div>
  <div class="col"><h2>이번 달 P&amp;L (발생주의)</h2><div class="big">${(state.this_month_summary?.current_month_pl ?? 0) >= 0 ? '+' : ''}${fmt(state.this_month_summary?.current_month_pl || 0)}</div>
    <small style="color:#888">수입 ${fmt(state.this_month_summary?.total_income || 0)} / 지출 ${fmt(state.this_month_summary?.total_expense || 0)}${state.this_month_summary?.total_card_payment ? `<br>카드값 결제 ${fmt(state.this_month_summary.total_card_payment)} <span style="color:#666">(P&amp;L 무관)</span>` : ''}</small></div>
</div>
${forecastBlock}
<div class="col" style="margin-bottom:12px">${goalBlock}</div>
${pendingBlock}
<h2>카테고리별</h2>
<table>${catRows || '<tr><td colspan="2" style="color:#666">기록 없음</td></tr>'}</table>
${voucherBlock}
<script>
document.getElementById('m').addEventListener('change', e => {
  parent.postMessage({ type: 'widget-state-change', state: { month: e.target.value } }, '*');
});
</script>
</body></html>`,
  };
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
