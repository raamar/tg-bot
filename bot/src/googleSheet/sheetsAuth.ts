import { GoogleAuth } from 'google-auth-library'
import { sheets, type sheets_v4 } from '@googleapis/sheets'

type CreateClientOpts = {
  keyFilePathEnv?: string
  jsonEnv?: string
  jsonBase64Env?: string
  scopes?: string[]
}

export const createSheetsClient = async (opts: CreateClientOpts = {}): Promise<sheets_v4.Sheets> => {
  const scopes = opts.scopes ?? ['https://www.googleapis.com/auth/spreadsheets']

  const b64 = process.env[opts.jsonBase64Env ?? 'GOOGLE_SERVICE_ACCOUNT_JSON_BASE64']
  const raw = process.env[opts.jsonEnv ?? 'GOOGLE_SERVICE_ACCOUNT_JSON']
  const keyFile = process.env[opts.keyFilePathEnv ?? 'GOOGLE_APPLICATION_CREDENTIALS']

  if (b64) {
    const json = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'))
    const auth = new GoogleAuth({ credentials: json, scopes })
    return sheets({ version: 'v4', auth })
  }

  if (raw) {
    const json = JSON.parse(raw)
    const auth = new GoogleAuth({ credentials: json, scopes })
    return sheets({ version: 'v4', auth })
  }

  if (keyFile) {
    const auth = new GoogleAuth({ keyFile, scopes })
    return sheets({ version: 'v4', auth })
  }

  const auth = new GoogleAuth({ scopes })
  return sheets({ version: 'v4', auth })
}
