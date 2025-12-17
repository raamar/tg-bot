import { prisma } from '../prisma'
import { skipAllRemindersForUser, scheduleRemindersForStep } from '../reminders/scheduler'
import { enterStepForUser } from '../scenario/engine'
import { StepVisitSource } from '@prisma/client'
import fs from 'fs'
import path from 'path'

const STUCK_STEPS = [
  '1763357037127',
  '1763357718603',
  '1763357733126',
  '1763357073539',
  '1763357751260',
  '1763357770659',
  '1763357438352',
  '1763357793780',
  '1763357825473',
]

const NEXT_FOR_ALL_BEFORE = '1763357438352_2'
const NEXT_FOR_GROUP_AFTER = '1763357456249'

const TO_NEXT_FOR_GROUP_AFTER = new Set(['1763357438352', '1763357793780', '1763357825473'])

function resolveNextStep(currentStepId: string): string | null {
  if (TO_NEXT_FOR_GROUP_AFTER.has(currentStepId)) return NEXT_FOR_GROUP_AFTER
  if (STUCK_STEPS.includes(currentStepId)) return NEXT_FOR_ALL_BEFORE
  return null
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Глобальный limiter: запускает задачи не чаще N раз в секунду.
 * Ограничивает частоту наших вызовов (операций).
 */
class RateLimiter {
  private intervalMs: number
  private nextAt = 0
  private chain: Promise<void> = Promise.resolve()

  constructor(rps: number) {
    this.intervalMs = Math.ceil(1000 / rps)
  }

  run<T>(fn: () => Promise<T>): Promise<T> {
    const task = async () => {
      const now = Date.now()
      if (this.nextAt < now) this.nextAt = now
      const wait = this.nextAt - now
      this.nextAt += this.intervalMs
      if (wait > 0) await sleep(wait)
      return fn()
    }

    const p = this.chain.then(task, task)
    this.chain = p.then(
      () => undefined,
      () => undefined
    )
    return p
  }
}

type Row = {
  id: string
  telegramId: string
  currentStepId: string
  updatedAt: Date
}

type ErrorItem = {
  userId: string
  telegramId: string
  currentStepId: string
  nextStepId: string | null
  phase: 'recheck' | 'skipReminders' | 'enterStep' | 'scheduleReminders'
  message: string
  stack?: string
}

async function main() {
  const DRY_RUN = process.env.DRY_RUN === '1'
  const RPS = Number(process.env.RPS ?? 10)
  const limiter = new RateLimiter(RPS)

  const errors: ErrorItem[] = []
  const startedAt = Date.now()
  const errorsFile = path.resolve(process.cwd(), 'advance-stuck-errors.json')

  // Ровно твой запрос
  const rows = await prisma.$queryRaw<Row[]>`
    SELECT
      u.id,
      u."telegramId",
      u."currentStepId",
      u."updatedAt"
    FROM public."User" u
    WHERE u."paid" = false
      AND u."currentStepId" IN (
        '1763357037127', '1763357718603', '1763357733126', '1763357073539',
        '1763357751260', '1763357770659', '1763357438352', '1763357793780',
        '1763357825473'
      )
      AND u."updatedAt" < NOW() - INTERVAL '24 hours'
    ORDER BY u."currentStepId", u."updatedAt" ASC;
  `

  const total = rows.length
  console.log(`Found candidates: ${total}. DRY_RUN=${DRY_RUN}. RPS=${RPS}`)

  let processed = 0
  let ok = 0
  let skipped = 0
  let failed = 0

  const skippedReasons: Record<string, number> = {
    'no-mapping': 0,
    'already-changed': 0,
    'paid-now': 0,
    'too-recent-now': 0,
    'missing-user': 0,
  }

  function renderProgress() {
    const elapsedSec = Math.max(1, Math.floor((Date.now() - startedAt) / 1000))
    const speed = (processed / elapsedSec).toFixed(2)
    process.stdout.write(
      `\rProgress ${processed}/${total} | ok=${ok} skipped=${skipped} failed=${failed} | speed=${speed}/s | errors=${errors.length}   `
    )
  }

  renderProgress()

  for (const r of rows) {
    processed++

    const nextStepId = resolveNextStep(r.currentStepId)
    if (!nextStepId) {
      skipped++
      skippedReasons['no-mapping']++
      if (processed % 50 === 0) renderProgress()
      continue
    }

    // re-check (под лимитером)
    let fresh: { paid: boolean; currentStepId: string | null; updatedAt: Date } | null = null
    try {
      fresh = await limiter.run(() =>
        prisma.user.findUnique({
          where: { id: r.id },
          select: { paid: true, currentStepId: true, updatedAt: true },
        })
      )
    } catch (e: any) {
      failed++
      errors.push({
        userId: r.id,
        telegramId: r.telegramId,
        currentStepId: r.currentStepId,
        nextStepId,
        phase: 'recheck',
        message: e?.message ?? String(e),
        stack: e?.stack,
      })
      renderProgress()
      continue
    }

    if (!fresh) {
      skipped++
      skippedReasons['missing-user']++
      if (processed % 50 === 0) renderProgress()
      continue
    }

    if (fresh.paid) {
      skipped++
      skippedReasons['paid-now']++
      if (processed % 50 === 0) renderProgress()
      continue
    }

    if (fresh.currentStepId !== r.currentStepId) {
      skipped++
      skippedReasons['already-changed']++
      if (processed % 50 === 0) renderProgress()
      continue
    }

    if (fresh.updatedAt.getTime() > Date.now() - 24 * 60 * 60 * 1000) {
      skipped++
      skippedReasons['too-recent-now']++
      if (processed % 50 === 0) renderProgress()
      continue
    }

    if (DRY_RUN) {
      ok++
      if (processed % 50 === 0) renderProgress()
      continue
    }

    try {
      await limiter.run(() => skipAllRemindersForUser(r.id))
    } catch (e: any) {
      failed++
      errors.push({
        userId: r.id,
        telegramId: r.telegramId,
        currentStepId: r.currentStepId,
        nextStepId,
        phase: 'skipReminders',
        message: e?.message ?? String(e),
        stack: e?.stack,
      })
      renderProgress()
      continue
    }

    try {
      await limiter.run(() => enterStepForUser(r.id, nextStepId, StepVisitSource.SYSTEM))
    } catch (e: any) {
      failed++
      errors.push({
        userId: r.id,
        telegramId: r.telegramId,
        currentStepId: r.currentStepId,
        nextStepId,
        phase: 'enterStep',
        message: e?.message ?? String(e),
        stack: e?.stack,
      })
      renderProgress()
      continue
    }

    try {
      await limiter.run(() => scheduleRemindersForStep(r.id, nextStepId, 'default'))
      ok++
    } catch (e: any) {
      failed++
      errors.push({
        userId: r.id,
        telegramId: r.telegramId,
        currentStepId: r.currentStepId,
        nextStepId,
        phase: 'scheduleReminders',
        message: e?.message ?? String(e),
        stack: e?.stack,
      })
      renderProgress()
      continue
    }

    if (processed % 50 === 0) renderProgress()
  }

  renderProgress()
  process.stdout.write('\n')

  const elapsedSec = Math.max(1, Math.floor((Date.now() - startedAt) / 1000))
  console.log(`Done in ${elapsedSec}s`)
  console.log(`Summary: ok=${ok}, skipped=${skipped}, failed=${failed}`)
  console.log('Skipped reasons:', skippedReasons)

  if (errors.length > 0) {
    fs.writeFileSync(errorsFile, JSON.stringify(errors, null, 2), 'utf8')
    console.log(`Errors written to: ${errorsFile}`)
    console.log('Errors (preview up to 20):')
    for (const e of errors.slice(0, 20)) {
      console.log(
        `- user=${e.userId} tg=${e.telegramId} step=${e.currentStepId} -> ${e.nextStepId} phase=${e.phase}: ${e.message}`
      )
    }
    if (errors.length > 20) console.log(`...and ${errors.length - 20} more (see file).`)
  }
}

main()
  .catch((e) => {
    console.error('Fatal:', e)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
