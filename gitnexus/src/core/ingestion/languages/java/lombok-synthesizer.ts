/**
 * Lombok method synthesizer for Java.
 *
 * Lombok generates accessor methods (getters/setters) at compile time via
 * annotation processors. These methods are absent from the AST — every call
 * to `obj.getOrderId()` on a `@Data` class is an unresolved call edge in the
 * static graph.
 *
 * This module walks the tree-sitter Java AST and, for each class annotated
 * with `@Getter`, `@Setter`, or `@Data`, synthesizes virtual Method graph
 * nodes for the accessor methods Lombok would generate. The output mirrors
 * the shape of real Method symbols/nodes/relationships so the rest of the
 * ingestion pipeline treats them identically.
 *
 * Synthesized methods are:
 *  - **Public** (`visibility: 'public'`): Lombok's default access level.
 *  - **Non-static**: only instance fields get accessors.
 *  - **Skipped when a hand-written method of the same name already exists.**
 *  - **Skipped for final fields' setters** (Lombok never emits those).
 *  - **Skipped for fields explicitly suppressed** via `@Getter/@Setter(AccessLevel.NONE)`.
 *
 * Naming follows the JavaBeans convention Lombok uses:
 *  - `String name` → `getName()` / `setName(String)`
 *  - `boolean active` → `isActive()` / `setActive(boolean)`
 *  - `Boolean active` → `getActive()` (boxed → getXxx, per Lombok)
 *
 * ## Identity model (root-cause fix for name ambiguity)
 *
 * A class is identified by its class_declaration AST node, not by its simple
 * name — simple names are ambiguous across files and among nested classes
 * with the same tail (bot review: cross-file collision + `Outer.A` vs
 * `Other.A` overwriting each other in a name-keyed map). The caller keys the
 * owner map by tree-sitter node id (`SyntaxNode.id`, a stable per-tree
 * integer), which is unique by construction for every declaration in the
 * file, so both collisions are impossible rather than filtered out.
 *
 * The synthesized Method node id follows the SAME convention real methods
 * use in parse-worker: `${filePath}:${idMethodName}#${arity}` where
 * `idMethodName` is qualified by the IMMEDIATE enclosing class simple name
 * only (`Outer.method`, never the full `Top.Outer.method` chain) — matching
 * `findEnclosingClassInfo().className` + `nodeName`, which keys real Method
 * ids for languages without `qualifiedNodeId` (Java among them).
 */

import type Parser from 'tree-sitter';

// ── Types ─────────────────────────────────────────────────────────────────

/** A field extracted from the AST for Lombok synthesis. */
interface LombokField {
  name: string;
  type: string;
  isStatic: boolean;
  isFinal: boolean;
  /** True when @Getter(AccessLevel.NONE) suppresses the getter for this field. */
  suppressGetter: boolean;
  /** True when @Setter(AccessLevel.NONE) suppresses the setter for this field. */
  suppressSetter: boolean;
  /** Field-level access level override for the getter (default 'public'). */
  getterAccess: string;
  /** Field-level access level override for the setter (default 'public'). */
  setterAccess: string;
  /** Field-level Lombok @Getter opt-in (class default off, review P1). */
  enableGetter: boolean;
  /** Field-level Lombok @Setter opt-in (class default off, review P1). */
  enableSetter: boolean;
}

/** A class eligible for Lombok accessor synthesis. */
interface LombokClass {
  /** Tree-sitter node of the class_declaration — the class's identity. */
  node: Parser.SyntaxNode;
  /** Class simple name. */
  name: string;
  /** 'getter' and/or 'setter' depending on which annotations are present. */
  generateGetters: boolean;
  generateSetters: boolean;
  fields: LombokField[];
  /**
   * Hand-written methods in this class body, keyed by name with their
   * arities (review P2): a field `x` plus a hand-written `getX(int mode)`
   * (arity 1) must NOT suppress the zero-arg Lombok getter — Java resolves
   * overloads by arity, and both can coexist.
   */
  existingMethods: Map<string, Set<number>>;
  /** Effective access level from class-level @Getter/@Setter (P2: non-default levels). */
  getterAccess: string;
  setterAccess: string;
  /**
   * Id prefix for synthesized methods: the simple name, plus a `~N`
   * occurrence suffix ONLY when a same-named sibling class exists in this
   * file (nested-class same-tail collision, review P1).
   */
  idPrefix: string;
}

/** Synthetic symbol entry — mirrors the shape pushed to `result.symbols`. */
export interface SyntheticSymbol {
  filePath: string;
  name: string;
  nodeId: string;
  type: 'Method';
  ownerId: string;
  parameterCount: number;
  requiredParameterCount: number;
  parameterTypes: string[];
  returnType: string;
  visibility: string;
  isStatic: boolean;
  isAbstract: boolean;
  isFinal: boolean;
  isLombok: true;
}

/** Synthetic node entry — mirrors the shape pushed to `result.nodes`. */
export interface SyntheticNode {
  id: string;
  label: 'Method';
  properties: Record<string, unknown> & {
    name: string;
    filePath: string;
    startLine: number;
    endLine: number;
    language: string;
    isExported: boolean;
    synthetic: 'lombok';
    visibility: string;
    isStatic: boolean;
    returnType: string;
    parameterTypes: string[];
    parameterCount: number;
  };
}

/** Synthetic relationship entry — mirrors the shape pushed to `result.relationships`. */
export interface SyntheticRelationship {
  id: string;
  sourceId: string;
  targetId: string;
  type: 'HAS_METHOD';
  confidence: number;
  reason: string;
}

export interface LombokSynthesisResult {
  symbols: SyntheticSymbol[];
  nodes: SyntheticNode[];
  relationships: SyntheticRelationship[];
}

// ── Helpers ───────────────────────────────────────────────────────────────

/** Capitalize the first letter of a string. */
function capitalize(s: string): string {
  return s.length > 0 ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** Map a Lombok AccessLevel to the graph `visibility` value. */
function accessLevelToVisibility(level: string): string {
  switch (level) {
    case 'PUBLIC':
      return 'public';
    case 'PROTECTED':
      return 'protected';
    case 'PRIVATE':
    case 'NONE':
      return 'private';
    case 'PACKAGE':
    case 'MODULE':
      return 'package';
    default:
      return 'public';
  }
}

/**
 * Lombok's base-name rule: for a field named `isEnabled`, the accessor base
 * name is `enabled` (the `is` prefix is absorbed), so Lombok emits
 * `isEnabled()` / `setEnabled(...)` — NOT `isIsEnabled()`. Only a lowercase
 * `is` followed by an uppercase letter counts (Lombok's `^is[A-Z]` check),
 * so a field actually named `island` keeps its full name (`getIsland()`).
 */
function lombokBaseName(fieldName: string): string {
  if (fieldName.length > 2 && fieldName.startsWith('is') &&
      fieldName.charAt(2) === fieldName.charAt(2).toUpperCase()) {
    return fieldName.slice(2);
  }
  return fieldName;
}

/** Generate the Lombok getter method name for a field. */
function getterName(fieldName: string, fieldType: string): string {
  // Primitive boolean → isXxx(); everything else (incl. boxed Boolean) → getXxx()
  const base = capitalize(lombokBaseName(fieldName));
  if (fieldType === 'boolean') {
    return `is${base}`;
  }
  return `get${base}`;
}

/** Generate the Lombok setter method name for a field. */
function setterName(fieldName: string): string {
  return `set${capitalize(lombokBaseName(fieldName))}`;
}

interface AnnotationInfo {
  /** Simple name, e.g. `Data`. */
  simpleName: string;
  /** True when written as a bare (unqualified) `@Data`. */
  bare: boolean;
  /** True when written qualified with the real Lombok package `@lombok.Data`. */
  lombokQualified: boolean;
  /** Full argument text for AccessLevel parsing (empty when none). */
  argsText: string;
}

/**
 * Extract Lombok-relevant annotation info from a tree-sitter `modifiers` node.
 *
 * Qualification discipline (review P1): a third-party or project-local
 * `@Data`/`@Getter`/`@Setter` must NOT be treated as Lombok. We accept a
 * name only when it is (a) bare — `@Data`, by far the common form — or
 * (b) qualified with the actual Lombok package — `@lombok.Data`. A name
 * qualified with any other prefix (`@com.acme.Data`) is ignored.
 */
function extractAnnotationInfo(modifiersNode: Parser.SyntaxNode | null): Map<string, AnnotationInfo> {
  const infos = new Map<string, AnnotationInfo>();
  if (!modifiersNode) return infos;

  for (const child of modifiersNode.children) {
    if (child.type !== 'marker_annotation' && child.type !== 'annotation') continue;
    const nameNode = child.childForFieldName('name');
    const text = nameNode?.text ?? '';
    if (!text) continue;
    const dot = text.lastIndexOf('.');
    let bare = false;
    let lombokQualified = false;
    let simpleName = text;
    if (dot === -1) {
      bare = true;
    } else {
      simpleName = text.slice(dot + 1);
      lombokQualified = text.slice(0, dot) === 'lombok';
    }
    if (!simpleName) continue;
    // Argument text for AccessLevel parsing: `@Getter(AccessLevel.PROTECTED)`
    // → the `element_value_expression` content after `(`.
    let argsText = '';
    if (child.type === 'annotation') {
      const open = child.text.indexOf('(');
      const close = child.text.lastIndexOf(')');
      if (open !== -1 && close > open) argsText = child.text.slice(open + 1, close);
    }
    infos.set(simpleName, { simpleName, bare, lombokQualified, argsText });
  }
  return infos;
}

/** A Lombok annotation is one written bare or `lombok.`-qualified. */
function isLombokAnnotation(info: AnnotationInfo | undefined): boolean {
  if (!info) return false;
  return info.bare || info.lombokQualified;
}

/** AccessLevel value carried by an annotation's arguments, if any. */
function accessLevelOf(info: AnnotationInfo | undefined): string | undefined {
  if (!info || !info.argsText) return undefined;
  const m = /AccessLevel\s*\.\s*(NONE|PUBLIC|PROTECTED|PACKAGE|PRIVATE|MODULE)/.exec(info.argsText);
  return m ? m[1] : undefined;
}


/**
 * Parse a field declaration node to extract field name(s) and type.
 *
 * `private String name;` → [{ name: 'name', type: 'String', isStatic: false, isFinal: false }]
 * `private final Long id = 0L;` → [{ name: 'id', type: 'Long', isStatic: false, isFinal: true }]
 * `private int x, y;` → [{ name: 'x', ... }, { name: 'y', ... }]
 */
function parseFieldDeclaration(
  fieldNode: Parser.SyntaxNode,
): LombokField[] {
  const results: { name: string; type: string; isStatic: boolean; isFinal: boolean; suppressGetter: boolean; suppressSetter: boolean; getterAccess: string; setterAccess: string; enableGetter: boolean; enableSetter: boolean }[] = [];

  // Type is in the `type` field
  const typeNode = fieldNode.childForFieldName('type');
  const fieldType = typeNode?.text ?? 'Object';

  // Check static/final — tree-sitter-java uses the keyword itself as the node type
  // (e.g. `static`, `final`), not a wrapper `modifier` node.
  const modifiers = fieldNode.children.find((c) => c.type === 'modifiers');
  let isStatic = false;
  let isFinal = false;
  if (modifiers) {
    for (const mod of modifiers.children) {
      if (mod.text === 'static') {
        isStatic = true;
      } else if (mod.text === 'final') {
        isFinal = true;
      }
    }
  }

  // Collect all variable declarators — handles both single (`int x;`) and
  // multi-variable (`int x, y;`) declarations. The `declarator` field name
  // returns only the first one; the rest are unnamed children.
  const declarators: Parser.SyntaxNode[] = [];
  const declaratorField = fieldNode.childForFieldName('declarator');
  if (declaratorField) {
    declarators.push(declaratorField);
  }
  // Also collect unnamed variable_declarator children (multi-variable case)
  for (const child of fieldNode.children) {
    if (child.type === 'variable_declarator' && child !== declaratorField) {
      declarators.push(child);
    }
  }

  for (const declaratorNode of declarators) {
    const nameNode = declaratorNode.childForFieldName('name');
    if (nameNode) {
      results.push({
        name: nameNode.text,
        type: fieldType,
        isStatic,
        isFinal,
        suppressGetter: false,
        suppressSetter: false,
        getterAccess: 'public',
        setterAccess: 'public',
        enableGetter: false,
        enableSetter: false,
      });
    }
  }

  return results;
}

/**
 * Collect hand-written methods from a class body for collision detection.
 * Keyed by name → set of arities (review P2): a zero-arg Lombok getter is
 * only suppressed by a hand-written method with the SAME name and the SAME
 * (zero) arity — `getX(int mode)` is a distinct overload and Java keeps both.
 */
function collectExistingMethodArityMap(
  classBody: Parser.SyntaxNode | null,
): Map<string, Set<number>> {
  const map = new Map<string, Set<number>>();
  if (!classBody) return map;
  for (const child of classBody.children) {
    if (child.type !== 'method_declaration') continue;
    const nameNode = child.childForFieldName('name');
    if (!nameNode) continue;
    const params = child.childForFieldName('parameters');
    const arity = params
      ? params.children.filter((c) => c.type === 'formal_parameter' || c.type === 'spread_parameter').length
      : 0;
    let arities = map.get(nameNode.text);
    if (!arities) {
      arities = new Set<number>();
      map.set(nameNode.text, arities);
    }
    arities.add(arity);
  }
  return map;
}

/** True when a hand-written method with this name and arity exists. */
function hasMethodWithArity(
  map: Map<string, Set<number>>,
  name: string,
  arity: number,
): boolean {
  return map.get(name)?.has(arity) === true;
}

/**
 * Walk the tree for class_declaration nodes eligible for Lombok synthesis.
 *
 * Eligibility (review P1): a class participates when EITHER
 *  (a) a class-level Lombok `@Data`/`@Getter`/`@Setter` enables accessors by
 *      default, OR
 *  (b) at least one FIELD carries its own Lombok `@Getter`/`@Setter`
 *      (field-level annotations act as opt-in for that field alone).
 * Class-level `AccessLevel.NONE` disables that accessor class-wide (distinct
 * from field-level NONE, which suppresses per field).
 */
function findLombokClasses(root: Parser.SyntaxNode): LombokClass[] {
  const classes: LombokClass[] = [];

  // Pre-pass: count every class_declaration simple name in the file so a
  // same-named nested pair (First.Item / Second.Item) can be distinguished
  // regardless of Lombok eligibility (the non-Lombok twin still consumes
  // the plain id shape in the real capture path).
  const classNameCounts = new Map<string, number>();
  function countNames(node: Parser.SyntaxNode): void {
    if (node.type === 'class_declaration') {
      const n = node.childForFieldName('name')?.text;
      if (n) classNameCounts.set(n, (classNameCounts.get(n) ?? 0) + 1);
    }
    for (const child of node.children) countNames(child);
  }
  countNames(root);
  const seenSoFar = new Map<string, number>();

  function walk(node: Parser.SyntaxNode): void {
    if (node.type === 'class_declaration') {
      const modifiers = node.children.find((c) => c.type === 'modifiers');
      const annos = extractAnnotationInfo(modifiers);

      const isLombokData = isLombokAnnotation(annos.get('Data'));
      const classGetter = annos.get('Getter');
      const classSetter = annos.get('Setter');
      // Class-level NONE disables that accessor class-wide (review P1).
      const classGetterNone = isLombokAnnotation(classGetter) && accessLevelOf(classGetter) === 'NONE';
      const classSetterNone = isLombokAnnotation(classSetter) && accessLevelOf(classSetter) === 'NONE';
      const hasGetter = (isLombokData || (isLombokAnnotation(classGetter) && !classGetterNone));
      const hasSetter = (isLombokData || (isLombokAnnotation(classSetter) && !classSetterNone));
      const getterAccess = accessLevelOf(classGetter) ?? 'public';
      const setterAccess = accessLevelOf(classSetter) ?? 'public';

      const body = node.children.find((c) => c.type === 'class_body');

      // Field-level Lombok annotations make the class eligible even without
      // a class-level annotation (review P1).
      let fieldLevelEligible = false;
      const fields: LombokField[] = [];
      if (body) {
        for (const child of body.children) {
          if (child.type !== 'field_declaration') continue;
          const fieldMods = child.children.find((c) => c.type === 'modifiers');
          const fieldAnnos = extractAnnotationInfo(fieldMods);
          const fieldGetter = fieldAnnos.get('Getter');
          const fieldSetter = fieldAnnos.get('Setter');
          const fieldHasGetter = isLombokAnnotation(fieldGetter);
          const fieldHasSetter = isLombokAnnotation(fieldSetter);
          if (fieldHasGetter || fieldHasSetter) fieldLevelEligible = true;

          for (let f of parseFieldDeclaration(child)) {
            // Skip static fields (Lombok doesn't generate instance accessors for static fields)
            if (f.isStatic) continue;
            // Field-level NONE suppresses that accessor for this field only.
            const fieldGetterNone = fieldHasGetter && accessLevelOf(fieldGetter) === 'NONE';
            const fieldSetterNone = fieldHasSetter && accessLevelOf(fieldSetter) === 'NONE';
            // Class-wide default gates whether field annotations act as
            // opt-in or as overrides on top of the class default.
            if (fieldHasGetter && !fieldGetterNone) f.enableGetter = true;
            if (fieldHasSetter && !fieldSetterNone) f.enableSetter = true;
            if (fieldGetterNone) f.suppressGetter = true;
            if (fieldSetterNone) f.suppressSetter = true;
            // Effective access: field-level annotation wins over class default.
            f.getterAccess = fieldHasGetter ? (accessLevelOf(fieldGetter) ?? 'public') : getterAccess;
            f.setterAccess = fieldHasSetter ? (accessLevelOf(fieldSetter) ?? 'public') : setterAccess;
            fields.push(f);
          }
        }
      }

      if (hasGetter || hasSetter || fieldLevelEligible) {
        const nameNode = node.childForFieldName('name');
        const className = nameNode?.text ?? '';
        if (className) {
          const occurrence = seenSoFar.get(className) ?? 0;
          seenSoFar.set(className, occurrence + 1);
          // Plain shape when unique in file; `~N` disambiguator only when a
          // same-named sibling exists.
          const idPrefix =
            (classNameCounts.get(className) ?? 1) > 1
              ? `${className}~${occurrence}`
              : className;

          classes.push({
            node,
            name: className,
            generateGetters: hasGetter,
            generateSetters: hasSetter,
            fields,
            existingMethods: collectExistingMethodArityMap(body ?? null),
            getterAccess,
            setterAccess,
            idPrefix,
          });
        }
      }
    }

    // Recurse into children for nested classes
    for (const child of node.children) walk(child);
  }

  walk(root);
  return classes;
}

// ── Main API ──────────────────────────────────────────────────────────────

/**
 * Synthesize Lombok accessor methods for a Java file.
 *
 * Call this after the normal AST capture loop in parse-worker, for Java files
 * only. The returned symbols/nodes/relationships should be pushed into the
 * worker result so they flow through the rest of the pipeline unchanged.
 *
 * @param tree      The parsed tree-sitter Java AST.
 * @param filePath  Absolute file path.
 * @param classOwnersById  Map from tree-sitter node id (SyntaxNode.id) of the
 *                         class_declaration → graph node id of that class.
 *                         Keyed by AST node identity, so simple-name collisions
 *                         (across files or among same-tailed nested classes)
 *                         cannot resolve to the wrong class.
 * @returns Synthesis result, or empty if no Lombok classes found.
 */
export function synthesizeLombokAccessors(
  tree: Parser.Tree,
  filePath: string,
  classOwnersById: Map<number, string>,
): LombokSynthesisResult {
  const result: LombokSynthesisResult = {
    symbols: [],
    nodes: [],
    relationships: [],
  };

  const lombokClasses = findLombokClasses(tree.rootNode);

  for (const cls of lombokClasses) {
    const ownerId = classOwnersById.get(cls.node.id);
    if (!ownerId) continue; // Class not in the graph — skip

    // Synthesized method ids keep the REAL nested-member id shape
    // (`Inner.method`, matching findEnclosingClassInfo for languages without
    // `qualifiedNodeId` — Java among them) so call resolution can hit the
    // synthetic method. Collision-freedom (review P1) is achieved WITHOUT
    // breaking that shape: when two same-named classes share a file (which
    // only nested classes can do in Java), a `~N` occurrence index keeps
    // their synthetic ids distinct; a lone class keeps the plain name so
    // the common case stays byte-identical to real member ids.
    const idMethodNamePrefix = cls.idPrefix;

    for (const field of cls.fields) {
      // Getter: class default on, or field-level opt-in (review P1); suppressed
      // by field-level NONE; collides only with a same-name SAME-ARITY (0)
      // hand-written method (review P2 — overloads with args may coexist).
      const getterOn = (cls.generateGetters || field.enableGetter) && !field.suppressGetter;
      if (getterOn) {
        const gName = getterName(field.name, field.type);
        if (!hasMethodWithArity(cls.existingMethods, gName, 0)) {
          const nodeId = `Method:${filePath}:${idMethodNamePrefix}.${gName}#0`;
          // Lombok AccessLevel → graph visibility. PACKAGE/MODULE have no
          // Java keyword form that fits `visibility`; keep the enum name so
          // callers can see the real level (review P2).
          const gVis = accessLevelToVisibility(field.getterAccess);
          result.nodes.push({
            id: nodeId,
            label: 'Method',
            properties: {
              name: gName,
              filePath,
              startLine: 0,
              endLine: 0,
              language: 'java',
              isExported: false,
              synthetic: 'lombok',
              visibility: gVis,
              isStatic: false,
              returnType: field.type,
              parameterTypes: [],
              parameterCount: 0,
            },
          });
          result.symbols.push({
            filePath,
            name: gName,
            nodeId,
            type: 'Method',
            ownerId,
            parameterCount: 0,
            requiredParameterCount: 0,
            parameterTypes: [],
            returnType: field.type,
            visibility: gVis,
            isStatic: false,
            isAbstract: false,
            isFinal: false,
            isLombok: true,
          });
          result.relationships.push({
            id: `HAS_METHOD:${ownerId}->${nodeId}`,
            sourceId: ownerId,
            targetId: nodeId,
            type: 'HAS_METHOD',
            confidence: 1.0,
            reason: 'lombok-getter',
          });
        }
      }

      // Setter — class default on, or field-level opt-in; suppressed by
      // field-level NONE; final fields never get setters; collides only with
      // a same-name SAME-ARITY (1) hand-written setter.
      const setterOn = (cls.generateSetters || field.enableSetter) && !field.suppressSetter && !field.isFinal;
      if (setterOn) {
        const sName = setterName(field.name);
        if (!hasMethodWithArity(cls.existingMethods, sName, 1)) {
          const nodeId = `Method:${filePath}:${idMethodNamePrefix}.${sName}#1`;
          const sVis = accessLevelToVisibility(field.setterAccess);
          result.nodes.push({
            id: nodeId,
            label: 'Method',
            properties: {
              name: sName,
              filePath,
              startLine: 0,
              endLine: 0,
              language: 'java',
              isExported: false,
              synthetic: 'lombok',
              visibility: sVis,
              isStatic: false,
              returnType: 'void',
              parameterTypes: [field.type],
              parameterCount: 1,
            },
          });
          result.symbols.push({
            filePath,
            name: sName,
            nodeId,
            type: 'Method',
            ownerId,
            parameterCount: 1,
            requiredParameterCount: 1,
            parameterTypes: [field.type],
            returnType: 'void',
            visibility: sVis,
            isStatic: false,
            isAbstract: false,
            isFinal: false,
            isLombok: true,
          });
          result.relationships.push({
            id: `HAS_METHOD:${ownerId}->${nodeId}`,
            sourceId: ownerId,
            targetId: nodeId,
            type: 'HAS_METHOD',
            confidence: 1.0,
            reason: 'lombok-setter',
          });
        }
      }
    }
  }

  return result;
}
