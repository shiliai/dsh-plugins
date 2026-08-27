export interface AttachmentLimits {
  maxFileBytes: number
  maxFilesPerMessage: number
  maxMessageBytes: number
}

export interface UploadedFile {
  fileId: string
  name: string
  mediaType: string
  bytes: number
  uri: string
  expiresAt: number
}

export interface UploadInput {
  name: string
  mediaType: string
  data: string
}

export interface ApiErrorPayload {
  error: string
  code: string
}
