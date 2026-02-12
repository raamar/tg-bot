// wata.ts
// Minimal TS SDK for WATA H2H Links API (axios version)
// - Bearer JWT из env: WATA_ACCESS_TOKEN (без префикса "Bearer")
// - Environments: prod (api.wata.pro) / dev (api-sandbox.wata.pro)
// - JSON over REST, 60s timeout, optional debug logs

import axios, { AxiosError, AxiosInstance } from 'axios'

// ===================== Types & Errors =====================

export type WataMode = 'prod' | 'dev'

export type WataErrorCode =
  | 'Payment:PL_1001'
  | 'Payment:PL_1002'
  | 'Payment:PL_1003'
  | 'Payment:CRY_1001'
  | 'Payment:TRA_1001'
  | 'Payment:TRA_1002'
  | 'Payment:TRA_1003'
  | 'Payment:TRA_1004'
  | 'Payment:TRA_1005'
  | 'Payment:TRA_1013'
  | 'Payment:TRA_2001'
  | 'Payment:TRA_2002'
  | 'Payment:TRA_2003'
  | 'Payment:TRA_2004'
  | 'Payment:TRA_2006'
  | 'Payment:TRA_2007'
  | 'Payment:TRA_2009'
  | 'Payment:TRA_2010'
  | 'Payment:TRA_2011'
  | 'Payment:TRA_2012'
  | 'Payment:TRA_2013'
  | 'Payment:TRA_2014'
  | 'Payment:TRA_2015'
  | 'Payment:TRA_2017'
  | 'Payment:TRA_2018'
  | 'Payment:TRA_2019'
  | 'Payment:TRA_2020'
  | 'Payment:TRA_2021'
  | 'Payment:TRA_2022'
  | 'Payment:TRA_2023'
  | 'Payment:TRA_2024'
  | 'Payment:TRA_2999'

export class WataApiError extends Error {
  public readonly status: number
  public readonly code?: WataErrorCode | string
  public readonly raw?: unknown
  public readonly wwwAuthenticate?: string | null

  constructor(
    message: string,
    opts: { status: number; code?: string; raw?: unknown; wwwAuthenticate?: string | null }
  ) {
    super(message)
    this.name = 'WataApiError'
    this.status = opts.status
    this.code = opts.code
    this.raw = opts.raw
    this.wwwAuthenticate = opts.wwwAuthenticate ?? null
  }
}

// --- Create Payment Link ---
export type WataLinkType = 'OneTime' | 'ManyTime'
export type WataCurrency = 'RUB' | 'USD' | 'EUR'

export type CreatePaymentLinkRequest = {
  type?: WataLinkType
  amount: number
  currency: WataCurrency
  description?: string
  orderId?: string
  successRedirectUrl?: string
  failRedirectUrl?: string
  /** ISO string; default 3 days; min 10 minutes; max 30 days */
  expirationDateTime?: string
  isArbitraryAmountAllowed?: boolean
  arbitraryAmountPrompts?: number[]
}

export type CreatePaymentLinkResponse = {
  id: string
  type: WataLinkType
  amount: number
  currency: WataCurrency
  status: 'Opened' | 'Closed'
  url: string
  terminalName: string
  terminalPublicId: string
  creationTime: string
  orderId?: string
  description?: string
  successRedirectUrl?: string
  failRedirectUrl?: string
  expirationDateTime?: string
  isArbitraryAmountAllowed?: boolean
  arbitraryAmountPrompts?: number[]
}

// ===================== Client =====================

type EnvTokenReader = () => string | undefined

export type WataClientOptions = {
  /** Инициализируем один раз: выбираем окружение */
  mode: WataMode // "prod" | "dev"
  /** Кастомный ридер токена (по умолчанию: process.env.WATA_ACCESS_TOKEN) */
  tokenReader?: EnvTokenReader
  /** Таймаут запроса, мс (по умолчанию 60000) */
  timeoutMs?: number
  /** Включить подробный лог (тело, заголовки замаскированы) */
  debug?: boolean
}

export class WataClient {
  private readonly baseURL: string
  private readonly tokenReader: EnvTokenReader
  private readonly timeoutMs: number
  private readonly debug: boolean
  private readonly http: AxiosInstance

  constructor(opts: WataClientOptions) {
    this.baseURL = opts.mode === 'prod' ? 'https://api.wata.pro/api/h2h' : 'https://api-sandbox.wata.pro/api/h2h'

    this.tokenReader = opts.tokenReader ?? (() => (globalThis as any)?.process?.env?.WATA_ACCESS_TOKEN)

    this.timeoutMs = opts.timeoutMs ?? 60_000
    this.debug = !!opts.debug

    this.http = axios.create({
      baseURL: this.baseURL,
      timeout: this.timeoutMs,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      // validateStatus оставляем по умолчанию — не 2xx => выбросится AxiosError
    })

    // --- Interceptors: auth + debug ---
    this.http.interceptors.request.use((config) => {
      let token = this.tokenReader()
      if (!token) {
        throw new Error('WATA access token is missing. Set env WATA_ACCESS_TOKEN or provide tokenReader.')
      }
      token = normalizeToken(token)

      config.headers = config.headers ?? {}
      ;(config.headers as any).Authorization = `Bearer ${token}`

      if (this.debug) {
        const safeToken = maskToken(token)
        // eslint-disable-next-line no-console
        console.log(
          `[WATA] ${config.method?.toUpperCase()} ${this.baseURL}${config.url} (mode=${
            this.baseURL.includes('sandbox') ? 'dev' : 'prod'
          })`
        )
        // eslint-disable-next-line no-console
        console.log(`[WATA] headers: Authorization: Bearer ${safeToken}`)
        if (config.data) {
          // eslint-disable-next-line no-console
          console.log(`[WATA] body:`, config.data)
        }
      }
      return config
    })

    this.http.interceptors.response.use(
      (res) => {
        if (this.debug) {
          // eslint-disable-next-line no-console
          console.log(`[WATA] OK`)
        }
        return res
      },
      (err: AxiosError) => {
        // Преобразуем в WataApiError с максимумом контекста
        const status = err.response?.status ?? 0
        const data = err.response?.data as any | undefined
        const code = data?.code ?? data?.error ?? data?.errorCode ?? undefined
        const msg = data?.message ?? data?.detail ?? `HTTP ${status} from WATA`
        const wwwAuth = err.response?.headers?.['www-authenticate'] ?? null

        if (this.debug) {
          // eslint-disable-next-line no-console
          console.error(`[WATA] ERROR status=${status} code=${code ?? '-'} body=`, data ?? err.message)
          if (wwwAuth) {
            // eslint-disable-next-line no-console
            console.error(`[WATA] WWW-Authenticate: ${wwwAuth}`)
          }
        }

        throw new WataApiError(msg, {
          status,
          code,
          raw: data ?? err.toJSON?.() ?? String(err),
          wwwAuthenticate: typeof wwwAuth === 'string' ? wwwAuth : null,
        })
      }
    )
  }

  /** POST /links — создание одно/многоразовой платежной ссылки */
  async createPaymentLink(body: CreatePaymentLinkRequest): Promise<CreatePaymentLinkResponse> {
    const res = await this.http.post<CreatePaymentLinkResponse>('/links', body)
    return res.data
  }
}

// ===================== Utils =====================

function normalizeToken(token: string): string {
  return token.trim().replace(/^Bearer\s+/i, '')
}

function maskToken(token: string): string {
  if (token.length <= 10) return '****'
  return `${token.slice(0, 6)}…${token.slice(-4)}`
}
