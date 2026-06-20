import type { MemberRole } from '@prisma/client';

/** Hierarquia de permissões: número maior = mais poder. */
export const ROLE_RANK: Record<MemberRole, number> = {
  VIEWER: 1,
  MEMBER: 2,
  ADMIN: 3,
  OWNER: 4,
};

export function roleAtLeast(have: MemberRole, need: MemberRole): boolean {
  return ROLE_RANK[have] >= ROLE_RANK[need];
}
