/**
 * 账号登录已从个人分支移除。本文件仅保留 provider 家族身份常量与遥测归因的类型形状，
 * 供既有配置迁移与遥测载荷解析继续工作。
 */
export const BIGMODEL_PROVIDER_ID = "bigmodel" as const;
export const ZAI_PROVIDER_ID = "zai" as const;

export const CREDENTIAL_DECRYPT_ERROR_PREFIX = "凭据解密失败：" as const;
export const CREDENTIAL_DECRYPT_ERROR_CODE = "ZCODE_CREDENTIAL_DECRYPT_FAILED" as const;

export function isCredentialDecryptError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.startsWith(CREDENTIAL_DECRYPT_ERROR_PREFIX) &&
    error.message.includes(CREDENTIAL_DECRYPT_ERROR_CODE)
  );
}

export type OAuthProviderId = typeof ZAI_PROVIDER_ID | typeof BIGMODEL_PROVIDER_ID;

/** 历史渠道归因载荷的形状；账号移除后不再产生新数据，仅为遥测解析保留。 */
export interface OAuthLoginAttribution {
  source: string;
  planCode?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmContent?: string;
  utmTerm?: string;
}
