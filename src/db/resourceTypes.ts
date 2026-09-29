/**
 * Типы ресурсов для форм административной панели (например, выбор
 * ресурса при добавлении счётчика).
 */

export interface ResourceTypeOption {
  id: number;
  code: string;
  name: string;
  unit: string;
}

export async function listActiveResourceTypes(
  db: D1Database
): Promise<ResourceTypeOption[]> {
  const result = await db
    .prepare(
      "SELECT id, code, name, unit FROM resource_types WHERE is_active = 1 ORDER BY id"
    )
    .all<ResourceTypeOption>();

  return result.results;
}