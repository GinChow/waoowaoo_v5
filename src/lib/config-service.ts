/**
 * 统一配置服务
 *
 * 所有 API 通过此服务获取模型配置，确保数据源一致性。
 *
 * 质量参数由用户或平台固定；未固定的参数由调用方显式提供。
 * 项目只拥有画幅，不再拥有模型参数覆盖。
 */

import { prisma } from '@/lib/prisma'
import {
  type CapabilitySelections,
  type CapabilityValue,
} from '@/lib/ai-registry/types'
import {
  composeModelKey as composeStrictModelKey,
  parseModelKeyStrict,
} from '@/lib/ai-registry/selection'
import {
  type CapabilitySelectionValidationIssue,
  findBuiltinCapabilities,
  resolveGenerationOptionsForModel,
} from '@/lib/ai-registry/capabilities-catalog'
import { AiOptionValidationError } from '@/lib/ai-exec/normalize'
import { ensureAiCatalogsRegistered } from '@/lib/ai-exec/catalog-bootstrap'
import { getDeploymentConfig, isPlatformProviderCredentialMode } from '@/lib/deployment/config'
import { getDeploymentFeatures } from '@/lib/deployment/features'
import { getPlatformAssistantModelKey } from '@/lib/platform-models/catalog'
import { editionAi } from '@/lib/edition/current/ai'
import { parseStoredCapabilitySelections } from '@/lib/user-api/api-config-capability-defaults'
import {
  type WorkflowConcurrencyConfig,
  normalizeWorkflowConcurrencyConfig,
} from '@/lib/workflow-concurrency'
import { getDefaultWorkflowConcurrencyConfig } from '@/lib/workflow-concurrency-env'

export type ParsedModelKey = { provider: string, modelId: string }

/**
 * 解析模型复合 Key（严格模式，仅接受 provider::modelId）
 */
export function parseModelKey(key: string | null | undefined): ParsedModelKey | null {
  const parsed = parseModelKeyStrict(key)
  if (!parsed) return null
  return {
    provider: parsed.provider,
    modelId: parsed.modelId,
  }
}

/**
 * 组合 provider 与 modelId 为标准复合主键。
 */
export function composeModelKey(provider: string, modelId: string): string {
  return composeStrictModelKey(provider, modelId)
}

/**
 * 从复合 Key 中提取真正的 modelId（用于 API 调用）
 */
export function extractModelId(key: string | null | undefined): string | null {
  const parsed = parseModelKey(key)
  return parsed?.modelId || null
}

/**
 * 从模型字段中提取标准 modelKey（provider::modelId）
 */
export function extractModelKey(key: string | null | undefined): string | null {
  const parsed = parseModelKey(key)
  if (!parsed?.provider || !parsed?.modelId) return null
  return composeModelKey(parsed.provider, parsed.modelId)
}

/**
 * Project-level generation configuration. Models are no longer configured per
 * purpose: the Assistant chooses from the user's pool per item. What remains
 * project-owned is the output aspect ratio. capabilityDefaults is the existing
 * storage name for user/platform fixed selections, never project overrides.
 */
export interface ProjectModelConfig {
  videoRatio: string | null
  capabilityDefaults: CapabilitySelections
}

export interface UserModelConfig {
  assistantModel: string | null
  capabilityDefaults: CapabilitySelections
}

export async function getUserWorkflowConcurrencyConfig(
  userId: string,
): Promise<WorkflowConcurrencyConfig> {
  const defaultConcurrency = getDefaultWorkflowConcurrencyConfig()
  if (!getDeploymentFeatures(getDeploymentConfig()).showWorkflowConcurrency) {
    return defaultConcurrency
  }
  const userPref = await prisma.userPreference.findUnique({
    where: { userId },
    select: {
      analysisConcurrency: true,
      imageConcurrency: true,
      videoConcurrency: true,
    },
  })

  return normalizeWorkflowConcurrencyConfig({
    analysis: userPref?.analysisConcurrency,
    image: userPref?.imageConcurrency,
    video: userPref?.videoConcurrency,
  }, defaultConcurrency)
}

/**
 * 获取项目画幅与用户/平台固定参数。
 */
export async function getProjectModelConfig(
  projectId: string,
  userId: string,
): Promise<ProjectModelConfig> {
  ensureAiCatalogsRegistered()
  const deployment = getDeploymentConfig()
  const projectDataPromise = prisma.project.findUnique({
    where: { id: projectId },
    select: { videoRatio: true },
  })

  if (isPlatformProviderCredentialMode(deployment)) {
    const projectData = await projectDataPromise
    return {
      videoRatio: projectData?.videoRatio ?? null,
      capabilityDefaults: editionAi.readFixedParameters(),
    }
  }

  const [projectData, userPref] = await Promise.all([
    projectDataPromise,
    prisma.userPreference.findUnique({
      where: { userId },
      select: { capabilityDefaults: true },
    }),
  ])

  return {
    videoRatio: projectData?.videoRatio ?? null,
    capabilityDefaults: parseStoredCapabilitySelections(userPref?.capabilityDefaults, 'capabilityDefaults'),
  }
}

/**
 * 获取用户级 Assistant 配置；媒体模型由有效配置解析器按类别唯一解析
 */
export async function getUserModelConfig(userId: string): Promise<UserModelConfig> {
  ensureAiCatalogsRegistered()
  const deployment = getDeploymentConfig()
  if (isPlatformProviderCredentialMode(deployment)) {
    return {
      assistantModel: getPlatformAssistantModelKey(),
      capabilityDefaults: editionAi.readFixedParameters(),
    }
  }

  const userPref = await prisma.userPreference.findUnique({
    where: { userId },
    select: { assistantModel: true, capabilityDefaults: true },
  })

  return {
    assistantModel: extractModelKey(userPref?.assistantModel) || null,
    capabilityDefaults: parseStoredCapabilitySelections(userPref?.capabilityDefaults, 'capabilityDefaults'),
  }
}

export function resolveModelCapabilityGenerationOptions(input: {
  modelType: 'llm' | 'image' | 'video'
  modelKey: string
  capabilityDefaults?: CapabilitySelections
  runtimeSelections?: Record<string, CapabilityValue>
}): Record<string, CapabilityValue> {
  ensureAiCatalogsRegistered()
  const parsed = parseModelKeyStrict(input.modelKey)
  if (!parsed) {
    throw new Error(`MODEL_KEY_INVALID: ${input.modelKey}`)
  }

  const capabilities = findBuiltinCapabilities(input.modelType, parsed.provider, parsed.modelId)
  const resolved = resolveGenerationOptionsForModel({
    modelType: input.modelType,
    modelKey: input.modelKey,
    capabilities,
    capabilityDefaults: input.capabilityDefaults,
    runtimeSelections: input.runtimeSelections,
    requireAllFields: input.modelType !== 'llm',
  })

  if (resolved.issues.length > 0) {
    throw capabilityIssueToOptionValidationError(input.modelKey, resolved.issues[0])
  }

  return resolved.options
}

/**
 * A capability issue is caller input (a missing or disallowed option), not a
 * system fault. Surface it as the typed option-validation error so media
 * preflight classifies it as INVALID_PARAMS with the offending option field
 * instead of degrading a bare Error into INTERNAL_ERROR/SYSTEM/stop.
 */
function capabilityIssueToOptionValidationError(
  modelKey: string,
  issue: CapabilitySelectionValidationIssue,
): AiOptionValidationError {
  const fieldPrefix = `capabilities.${modelKey}.`
  const field = issue.field.startsWith(fieldPrefix)
    ? issue.field.slice(fieldPrefix.length)
    : undefined
  const failure = issue.code === 'CAPABILITY_REQUIRED'
    ? 'required_option'
    : issue.code === 'CAPABILITY_VALUE_NOT_ALLOWED'
      ? 'invalid_option'
      : issue.code === 'CAPABILITY_FIELD_INVALID'
        ? 'unsupported_option'
        : 'invalid_options'
  return new AiOptionValidationError({
    failure,
    context: modelKey,
    ...(field ? { field } : {}),
    reason: `${issue.code}: ${issue.message}`,
  })
}
