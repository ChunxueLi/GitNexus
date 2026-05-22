import type { ScopeId } from 'gitnexus-shared';

/**
 * Per-file set of `ScopeId`s that came from a `companion_object` AST node
 * (issue #1756 / U4 remediation).
 *
 * Populated during `emitKotlinScopeCaptures` from the `@scope.companion`
 * marker capture (see `query.ts`) and consumed by
 * `populateCompanionMembersOnEnclosingClass` in `owners.ts` to decide
 * whether to promote a class scope's methods onto its enclosing class.
 *
 * The previous `ownedDefs.some(isClassLike)` heuristic in `owners.ts`
 * silently misclassified two shapes as "regular classes":
 *   - named companions (`companion object Helper { ... }`) — the `Helper`
 *     `type_identifier` registered as a class-like def on the companion
 *     scope, hiding the companion-ness from the heuristic; AND
 *   - companions containing nested classes (`companion object { class
 *     Token; fun create() }`) — the nested class def lived on the
 *     companion scope, again hiding it from the heuristic.
 *
 * The marker capture lifts that distinction up to the parser layer
 * where it is unambiguous (any `companion_object` AST node is a
 * companion, regardless of what it contains).
 *
 * Parallels the C-language pattern in `c/static-linkage.ts`: per-file
 * `Map<filePath, Set<key>>` side-channel for language-specific def /
 * scope metadata that does not belong on the shared `Scope` /
 * `SymbolDefinition` types.
 *
 * NOTE: module-level state, single-process-single-repo use only. For
 * server-mode or multi-repo-in-one-process use cases, call
 * `clearCompanionScopes()` between resolution passes to avoid stale
 * companion-scope ids from a previous invocation.
 */
const companionScopesByFile = new Map<string, Set<ScopeId>>();

/** Record a scope id as a companion-object scope for the given file. */
export function markCompanionScope(filePath: string, scopeId: ScopeId): void {
  let scopes = companionScopesByFile.get(filePath);
  if (scopes === undefined) {
    scopes = new Set<ScopeId>();
    companionScopesByFile.set(filePath, scopes);
  }
  scopes.add(scopeId);
}

/** Check whether `scopeId` belongs to a companion-object scope in `filePath`. */
export function isCompanionScope(filePath: string, scopeId: ScopeId): boolean {
  return companionScopesByFile.get(filePath)?.has(scopeId) ?? false;
}

/** Clear all tracked companion scopes (for testing). */
export function clearCompanionScopes(): void {
  companionScopesByFile.clear();
}
