import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'

const requireEnv = (key: string): string => {
  const value = process.env[key]
  if (!value) {
    throw new Error(`${key} is not defined`)
  }
  return value
}

const endpoint = requireEnv('S3_ENDPOINT')
const region = requireEnv('S3_REGION')
const accessKeyId = requireEnv('S3_ACCESS_KEY')
const secretAccessKey = requireEnv('S3_SECRET_KEY')
const bucket = requireEnv('S3_BUCKET_NAME')

const forcePathStyle = process.env.S3_FORCE_PATH_STYLE === 'true' || process.env.S3_FORCE_PATH_STYLE === '1'

const s3 = new S3Client({
  region,
  endpoint,
  credentials: { accessKeyId, secretAccessKey },
  forcePathStyle,
})

const normalizeBaseUrl = (raw: string): string => raw.replace(/\/+$/, '')

export const getS3PublicUrl = (key: string): string => {
  const baseUrl = normalizeBaseUrl(process.env.S3_PUBLIC_URL || endpoint)
  return `${baseUrl}/${bucket}/${key}`
}

export const uploadReceiptToS3 = async (key: string, body: Buffer, contentType?: string): Promise<string> => {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType || 'application/octet-stream',
    }),
  )

  return getS3PublicUrl(key)
}
