export const PROJECT_AI_CONTEXT_MAX_LENGTH = 1200;

export function normalizeProjectAiContext(value?: string | null) {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, PROJECT_AI_CONTEXT_MAX_LENGTH);
}
