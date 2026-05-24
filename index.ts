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
  list(prefix?: string, limit?: number): Promise<Array<{ key: string; value?: any; updated_at: string }>>;
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
    case 'get_state': return getState(args, data);
    case 'daily_briefing': return dailyBriefing(data);
    case 'render_board': return renderBoard(args, data);
    default: throw new Error(`알 수 없는 함수: ${tool}. 뭘 부른 거냐.`);
  }
}

async function setupState(args: any, data: DataAPI) {
  const accounts: Account[] = args.accounts ?? [];
  const debts: Debt[] = args.debts ?? [];
  const goal = args.goal as Omit<Goal, 'created_at'> | undefined;
  const written: string[] = [];

  for (const a of accounts) {
    if (!a.id || !a.name) throw new Error('account 에 id, name 빠졌다. 다시 적어.');
    await data.set(`account:${a.id}`, { ...a, balance: Number(a.balance) || 0 });
    written.push(`account:${a.id}`);
  }
  for (const d of debts) {
    if (!d.id || !d.name) throw new Error('debt 에 id, name 빠졌다. 다시 적어.');
    await data.set(`debt:${d.id}`, { ...d, balance: Number(d.balance) || 0 });
    written.push(`debt:${d.id}`);
  }
  if (goal) {
    if (!goal.amount || !goal.deadline) throw new Error('goal 에 amount, deadline 필요해.');
    if (!goal.rationale) throw new Error('rationale 을 빼먹었구만. 왜 이 숫자 / 기한인지 적어. 나중에 본인이 까먹는다.');
    await data.set('goal', { ...goal, created_at: now() });
    written.push('goal');
  }

  return {
    text: `그래, 적어뒀다. ${written.length}건. 자산 ${accounts.length}, 부채 ${debts.length}${goal ? ', 목표 1' : ''}. 본인이 적은 거니까 나중에 우기지 마라.`,
    written,
  };
}

async function recordTransaction(args: any, data: DataAPI) {
  const type = args.type as Transaction['type'];
  const amount = Number(args.amount);
  if (!type || !amount) throw new Error('type 과 amount 가 필요하다. 둘 다 적어.');
  if (!['expense', 'income', 'transfer', 'card_payment'].includes(type)) {
    throw new Error('type 은 expense | income | transfer | card_payment 중 하나다.');
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
      const c = await adjustBalance(data, txn.to_account, +amount);
      if (c) balanceChanges.push(c);
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
    if (a) anomalyNote = ` 그리고 — ${a}`;
  }

  // 톤 가변: 금액 크기에 따라 잔소리 강도
  let lead = '';
  if (type === 'expense') {
    if (amount >= 100000) lead = `${fmt(amount)}원? 또 크게 썼구만. 적었다.`;
    else if (amount >= 30000) lead = `${fmt(amount)}원 썼냐. 적어둔다.`;
    else lead = `${fmt(amount)}원, 적었다.`;
  } else if (type === 'income') lead = `${fmt(amount)}원 들어왔다고? 흘려보내지 마라. 적어뒀다.`;
  else if (type === 'transfer') lead = `통장 이동 ${fmt(amount)}원. 적었다.`;
  else lead = `카드값 ${fmt(amount)}원 결제 처리. 부채에서 빼뒀다 (지출 아니다, 안 헷갈리게 해).`;

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

  const monthlyResults = await Promise.all(months.map(ym => data.list(`txn:${ym}:`)));
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
    const question = `${txn.category} 평균 ${fmt(avg)}원인데 이번엔 ${fmt(txn.amount)}원? 뭐 샀냐.`;
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
  if (!name || !amount) throw new Error('voucher_name 과 amount_used 가 필요하다.');
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
    text: `${name} ${fmt(amount)}원 깠다. 장부 잔액 ${fmt(newBal)}원. 더 안 받아오면 곧 동난다.`,
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

  if (!source || !accountId || !start || !end) throw new Error('source, account_id, period_start, period_end 필요하다.');

  const startMonth = start.slice(0, 7);
  const endMonth = end.slice(0, 7);
  const monthList: string[] = [];
  const mc = new Date(startMonth + '-01T00:00:00Z');
  const me = new Date(endMonth + '-01T00:00:00Z');
  while (mc <= me) {
    monthList.push(mc.toISOString().slice(0, 7));
    mc.setUTCMonth(mc.getUTCMonth() + 1);
  }
  const monthResults = await Promise.all(monthList.map(ym => data.list(`txn:${ym}:`)));
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
          question: `${bt.date} ${bt.merchant || '?'} ${fmt(amt)}원, 기록 없다. 빼먹은 거냐 아니냐.`,
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
        question: `${mm.bank_txn.date} ${mm.bank_txn.merchant || '?'}: 적은 건 ${fmt(mm.user_amount)}원, 실제 승인 ${fmt(mm.bank_amount)}원. 어느 쪽이 맞냐.`,
      },
    });
    queuedCount++;
  }

  // 톤 가변
  let lead: string;
  if (missing.length === 0 && mismatched.length === 0) {
    lead = `대조 끝. 일치 ${matched.size}건. 이번엔 봐줄 만하다.`;
  } else if (missing.length + mismatched.length >= 5) {
    lead = `대조했다. 일치 ${matched.size}, 누락 ${missing.length}${autoAdd ? ` (자동 추가 ${addedCount})` : ''}, 금액 불일치 ${mismatched.length}. 이렇게 줄줄 새면 모이겠냐. 정신 차려라.`;
  } else {
    lead = `대조 끝. 일치 ${matched.size}, 누락 ${missing.length}${autoAdd ? ` (자동 추가 ${addedCount})` : ''}, 금액 불일치 ${mismatched.length}. 큐에 ${queuedCount}건 쌓였으니 처리해라.`;
  }

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
  if (!pid || !action) throw new Error('pending_id, action 필요하다.');
  const pending = (await data.get(`pending:${pid}`)) as Pending | null;
  if (!pending) throw new Error(`그런 pending_id 없다: ${pid}`);

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
  return { text: `처리했다. 다음.`, status: 'resolved' };
}

async function addRecurring(args: any, data: DataAPI) {
  const name = args.name as string;
  const amount = Number(args.amount);
  const kind = args.kind as Recurring['kind'];
  if (!name || !amount || !kind) throw new Error('name, amount, kind 필요하다.');
  if (!['expense', 'income', 'sinking_fund'].includes(kind)) {
    throw new Error('kind 는 expense | income | sinking_fund 중 하나.');
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
    ? `연 ${fmt(amount)}원이면 매월 ${fmt(amount / 12)}원씩 미리 떼어놓겠다. 그래야 갑자기 큰 지출에 안 놀란다.`
    : kind === 'expense' ? `매월 ${fmt(amount)}원 할당이다.` : `월 ${fmt(amount)}원 수입으로 잡았다.`;
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
    if (txn.to_account) await adjustBalance(data, txn.to_account, +amt);
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
  if (!entityType) throw new Error('entity_type 필요하다.');
  if (!patch || Object.keys(patch).length === 0) throw new Error('patch 가 비었다. 뭘 고치라는 거냐.');

  if (entityType === 'goal') {
    const cur = (await data.get('goal')) as Goal | null;
    if (!cur) throw new Error('goal 없다. setup_state 로 먼저 박아라.');
    const next = { ...cur, ...patch };
    await data.set('goal', next);
    return { text: `목표 갱신했다. ${fmt(next.amount)}원 by ${next.deadline}.`, entity: next };
  }

  if (!id) throw new Error(`${entityType} 수정은 id 필요하다.`);

  if (entityType === 'account' || entityType === 'debt') {
    const key = `${entityType}:${id}`;
    const cur = await data.get(key);
    if (!cur) throw new Error(`${key} 없다.`);
    const next = { ...cur, ...patch };
    if (patch.balance !== undefined) next.balance = Number(patch.balance);
    await data.set(key, next);
    return { text: `${next.name || id} 갱신했다.`, entity: next };
  }

  if (entityType === 'recurring') {
    const key = `recurring:${id}`;
    const cur = await data.get(key);
    if (!cur) throw new Error(`${key} 없다.`);
    const next = { ...cur, ...patch };
    if (patch.amount !== undefined) next.amount = Number(patch.amount);
    await data.set(key, next);
    return { text: `${next.name || id} 정기 항목 갱신.`, entity: next };
  }

  if (entityType === 'transaction') {
    const month = args.month as string;
    if (!month) throw new Error('transaction 수정은 month (YYYY-MM) 필요하다.');
    const key = `txn:${month}:${id}`;
    const cur = (await data.get(key)) as Transaction | null;
    if (!cur) throw new Error(`${key} 없다.`);
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
    return { text: `거래 ${id} 갱신했다. ${fmt(next.amount)}원. 잔고 자동 보정.`, entity: next };
  }

  if (entityType === 'voucher_use') {
    const voucherName = args.voucher_name as string;
    if (!voucherName) throw new Error('voucher_use 수정은 voucher_name 필요하다.');
    const key = `voucher:${voucherName}:${id}`;
    const cur = await data.get(key);
    if (!cur) throw new Error(`${key} 없다.`);
    const oldAmount = Number(cur.amount_used);
    const next = { ...cur, ...patch };
    if (patch.amount_used !== undefined) next.amount_used = Number(patch.amount_used);
    await data.set(key, next);
    // 바우처 잔액 보정: 옛 금액 복원 + 새 금액 차감 = +oldAmount - newAmount
    const delta = oldAmount - Number(next.amount_used);
    if (delta !== 0) {
      const balKey = `voucher_balance:${voucherName}`;
      const bal = (await data.get(balKey)) as { balance: number } | null;
      const newBal = (bal?.balance ?? 0) + delta;
      await data.set(balKey, { balance: newBal });
    }
    return { text: `${voucherName} 사용 기록 갱신. 잔액도 보정.`, entity: next };
  }

  throw new Error(`알 수 없는 entity_type: ${entityType}`);
}

async function deleteEntry(args: any, data: DataAPI) {
  const entityType = args.entity_type as string;
  const id = args.id as string | undefined;
  if (!entityType) throw new Error('entity_type 필요하다.');

  if (entityType === 'goal') {
    const ok = await data.delete('goal');
    return { text: ok ? '목표 지웠다. 뭐 위해 모으냐 이젠.' : '목표 없는데 뭘 지우냐.', deleted: ok };
  }

  if (!id) throw new Error(`${entityType} 삭제는 id 필요하다.`);

  if (entityType === 'account' || entityType === 'debt') {
    const key = `${entityType}:${id}`;
    const ok = await data.delete(key);
    return {
      text: ok
        ? `${key} 지웠다. 묶인 과거 거래의 잔고 정합성은 본인 책임이다.`
        : `${key} 없다.`,
      deleted: ok,
    };
  }

  if (entityType === 'recurring') {
    const key = `recurring:${id}`;
    const ok = await data.delete(key);
    return {
      text: ok ? `정기 항목 ${id} 지웠다. 다음부터 할당 안 잡힌다.` : `recurring:${id} 없다.`,
      deleted: ok,
    };
  }

  if (entityType === 'transaction') {
    const month = args.month as string;
    if (!month) throw new Error('transaction 삭제는 month (YYYY-MM) 필요하다.');
    const key = `txn:${month}:${id}`;
    const cur = (await data.get(key)) as Transaction | null;
    if (!cur) return { text: `${key} 없다.`, deleted: false };
    await applyTxnBalance(data, cur, -1);
    await data.delete(key);
    return { text: `거래 ${id} (${fmt(cur.amount)}원) 지웠고 잔고 되돌렸다.`, deleted: true };
  }

  if (entityType === 'voucher_use') {
    const voucherName = args.voucher_name as string;
    if (!voucherName) throw new Error('voucher_use 삭제는 voucher_name 필요하다.');
    const key = `voucher:${voucherName}:${id}`;
    const cur = await data.get(key);
    if (!cur) return { text: `${key} 없다.`, deleted: false };
    const amt = Number(cur.amount_used);
    const balKey = `voucher_balance:${voucherName}`;
    const bal = (await data.get(balKey)) as { balance: number } | null;
    await data.set(balKey, { balance: (bal?.balance ?? 0) + amt });
    await data.delete(key);
    return { text: `${voucherName} 사용 ${fmt(amt)}원 취소. 잔액 복원했다.`, deleted: true };
  }

  throw new Error(`알 수 없는 entity_type: ${entityType}`);
}

function scroogeNag(state: any, intensity: string): string[] {
  const lines: string[] = [];
  const harsh = intensity === '매섭게';
  const soft = intensity === '부드럽게';

  if (state.spendable < 0) {
    lines.push(harsh
      ? `쓸 돈이 ${fmt(Math.abs(state.spendable))}원이나 모자라다. 미친놈아.`
      : soft ? `쓸 돈이 ${fmt(Math.abs(state.spendable))}원 모자라. 조심해.`
      : `쓸 돈이 ${fmt(Math.abs(state.spendable))}원 모자라다. 정신 차려라.`);
  }
  if (state.pace_vs_goal && !state.pace_vs_goal.on_track) {
    lines.push(`목표 미달 페이스다. 월 ${fmt(state.pace_vs_goal.needed_per_month)}원은 모아야 도달한다.`);
  }
  const pending = state.pending?.length || 0;
  if (pending > 0) lines.push(`미해결 ${pending}건 쌓였다. 답이나 해라.`);

  const exp = state.this_month_summary?.total_expense || 0;
  const inc = state.this_month_summary?.total_income || 0;
  if (inc > 0 && exp > inc) {
    lines.push(`이번 달 ${fmt(exp - inc)}원 마이너스다. 적자다 적자.`);
  }

  const cats = state.this_month_summary?.by_category || {};
  const total = (Object.values(cats) as number[]).reduce((s, v) => s + v, 0);
  const sorted = Object.entries(cats).sort((a: any, b: any) => b[1] - a[1]);
  const top = sorted[0];
  if (top && total > 0 && ((top[1] as number) / total) > 0.5) {
    lines.push(`${top[0]}이 전체 지출의 ${Math.round(((top[1] as number) / total) * 100)}%다. 한 군데 몰빵 그만해라.`);
  }

  if (lines.length === 0) {
    lines.push(harsh ? '아직 큰 사고는 안 쳤다. 방심하지 마라.' : '이번엔 봐줄 만하다. 방심하지 마라.');
  }
  return lines;
}

async function getState(args: any, data: DataAPI) {
  const month = (args.month as string) || thisMonth();

  const [accounts, debts, recurrings, pendings, voucherBalances, goalRaw, monthTxns, settingsRaw] = await Promise.all([
    data.list('account:'),
    data.list('debt:'),
    data.list('recurring:'),
    data.list('pending:'),
    data.list('voucher_balance:'),
    data.get('goal'),
    data.list(`txn:${month}:`),
    data.get('__settings'),
  ]);

  const allTxns = monthTxns.map(r => r.value as Transaction).filter(Boolean);

  const byCategory: Record<string, number> = {};
  let totalExpense = 0, totalIncome = 0;
  for (const t of allTxns) {
    if (t.type === 'expense') {
      totalExpense += t.amount;
      const c = t.category || '미분류';
      byCategory[c] = (byCategory[c] || 0) + t.amount;
    } else if (t.type === 'income') totalIncome += t.amount;
  }

  const recurringItems = recurrings.map(r => r.value as Recurring).filter(Boolean);
  const allocations: Array<{ name: string; monthly: number; kind: string }> = [];
  let totalAllocated = 0;
  for (const r of recurringItems) {
    if (r.kind === 'sinking_fund') {
      const m = Math.round(r.amount / 12);
      allocations.push({ name: r.name, monthly: m, kind: 'sinking_fund' });
      totalAllocated += m;
    } else if (r.kind === 'expense') {
      allocations.push({ name: r.name, monthly: r.amount, kind: 'expense' });
      totalAllocated += r.amount;
    }
  }

  const totalAssets = accounts.reduce((s, r) => s + ((r.value?.balance) || 0), 0);
  const totalDebt = debts.reduce((s, r) => s + ((r.value?.balance) || 0), 0);
  const netWorth = totalAssets - totalDebt;
  const spendable = totalAssets - totalDebt - totalAllocated;

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
    pace = {
      months_left: monthsLeft,
      remaining,
      needed_per_month: neededPerMonth,
      current: netWorth,
      on_track: netWorth >= expectedSavings,
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
    this_month_summary: { total_expense: totalExpense, total_income: totalIncome, by_category: byCategory },
    pace_vs_goal: pace,
    recent_transactions: recent,
    pending: pendingItems,
    voucher_balances: voucherBalanceMap,
    recurring: recurringItems,
  };

  const intensity = (settingsRaw as any)?.nag_intensity || '보통';
  return { ...result, nag: scroogeNag(result, intensity) };
}

async function dailyBriefing(data: DataAPI) {
  const state: any = await getState({}, data);
  const settings = (await data.get('__settings')) || {};
  const intensity = settings.nag_intensity || '보통';

  const body = (state.nag || []).slice(0, 2).join(' · ');
  if (!body) return { notifications: [] };

  return {
    notifications: [{
      id: `daily-${today()}`,
      title: `스크루지의 오늘 잔소리 (${intensity})`,
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

  const goalBlock = state.goal ? `
    <div><strong>목표</strong> ${fmt(state.goal.amount)} by ${state.goal.deadline}
    <br><small style="color:#888">${escapeHtml(state.goal.rationale || '')}</small>
    <br>순자산 ${fmt(state.net_worth)} (${Math.round((state.net_worth / state.goal.amount) * 100)}%)
    ${state.pace_vs_goal ? `<br><small style="color:${state.pace_vs_goal.on_track ? '#7c7' : '#e77'}">${state.pace_vs_goal.on_track ? '✓ 페이스 OK' : `✗ 월 ${fmt(state.pace_vs_goal.needed_per_month)}원 더 모아야 함`}</small>` : ''}
    </div>` : '<div style="color:#888">목표 미설정. 뭘 위해 모으냐.</div>';

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
      <strong style="color:#f4b942">스크루지의 한마디</strong><br>
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
  <div class="col"><h2>이번 달 지출</h2><div class="big">${fmt(state.this_month_summary?.total_expense || 0)}</div>
    <small style="color:#888">수입 ${fmt(state.this_month_summary?.total_income || 0)}</small></div>
</div>
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
