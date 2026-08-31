/**
 * Unit test: Lombok accessor method synthesis.
 *
 * Tests the lombok-synthesizer module directly (no worker pool needed).
 * Verifies that @Data/@Getter/@Setter annotated classes produce the correct
 * synthetic getter/setter methods, with proper naming conventions, collision
 * guards, and AccessLevel.NONE suppression.
 *
 * The owner map is keyed by class_declaration AST node id (SyntaxNode.id) —
 * mirroring how parse-worker fills it from the capture loop — so tests build
 * it by walking the parsed tree for class declarations.
 */
import { describe, it, expect } from 'vitest';
import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';
import { synthesizeLombokAccessors } from '../../src/core/ingestion/languages/java/lombok-synthesizer.js';

function parse(code: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage(Java);
  return parser.parse(code);
}

const FILE_PATH = '/test/Order.java';

/**
 * Build the AST-node-id → graph-node-id map the way parse-worker does:
 * `Class:<file>:<Name>` for top-level classes and `Class:<file>:<Outer>.<Name>`
 * for nested ones (the capture loop keys a class id by its simple name when
 * top-level, and by `<immediateParentSimpleName>.<name>` when nested — see
 * findEnclosingClassInfo). Only the KEY is load-bearing for the synthesizer
 * (the AST node id); values mirror the real graph ids so edge assertions
 * below observe production shapes.
 */
function ownerMapBySimpleName(
  tree: Parser.Tree,
  filePath: string,
): Map<number, string> {
  const map = new Map<number, string>();
  const CLASS_LIKE = new Set([
    'class_declaration',
    'interface_declaration',
    'enum_declaration',
    'record_declaration',
  ]);
  const immediateParentName = (node: Parser.SyntaxNode): string | null => {
    for (let current = node.parent; current; current = current.parent) {
      if (CLASS_LIKE.has(current.type)) {
        const nameNode = current.childForFieldName('name');
        if (nameNode) return nameNode.text;
      }
    }
    return null;
  };
  const walk = (node: Parser.SyntaxNode): void => {
    if (node.type === 'class_declaration') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        const parent = immediateParentName(node);
        const key = parent ? `${parent}.${nameNode.text}` : nameNode.text;
        map.set(node.id, `Class:${filePath}:${key}`);
      }
    }
    for (const child of node.children) walk(child);
  };
  walk(tree.rootNode);
  return map;
}

describe('synthesizeLombokAccessors', () => {
  describe('@Data annotation', () => {
    it('generates both getter and setter for each field', () => {
      const tree = parse(`
@Data
public class Order {
    private String orderId;
    private Long amount;
}
`);
      const classNodeIds = ownerMapBySimpleName(tree, FILE_PATH);
      const result = synthesizeLombokAccessors(tree, FILE_PATH, classNodeIds);

      // 2 fields × 2 (getter + setter) = 4 synthetic methods
      expect(result.symbols).toHaveLength(4);

      const names = result.symbols.map((s) => s.name).sort();
      expect(names).toEqual(['getAmount', 'getOrderId', 'setAmount', 'setOrderId']);
    });

    it('sets correct return types and parameter types', () => {
      const tree = parse(`
@Data
public class Order {
    private String orderId;
}
`);
      const classNodeIds = ownerMapBySimpleName(tree, FILE_PATH);
      const result = synthesizeLombokAccessors(tree, FILE_PATH, classNodeIds);

      const getter = result.symbols.find((s) => s.name === 'getOrderId')!;
      expect(getter).toBeDefined();
      expect(getter.returnType).toBe('String');
      expect(getter.parameterTypes).toEqual([]);
      expect(getter.parameterCount).toBe(0);

      const setter = result.symbols.find((s) => s.name === 'setOrderId')!;
      expect(setter).toBeDefined();
      expect(setter.returnType).toBe('void');
      expect(setter.parameterTypes).toEqual(['String']);
      expect(setter.parameterCount).toBe(1);
    });

    it('creates HAS_METHOD relationships linking to the class', () => {
      const tree = parse(`
@Data
public class Order {
    private String orderId;
}
`);
      const classNodeIds = ownerMapBySimpleName(tree, FILE_PATH);
      const result = synthesizeLombokAccessors(tree, FILE_PATH, classNodeIds);

      // At least one getter AND one setter edge — the loop below must not be
      // vacuous (an empty result would pass it trivially).
      expect(result.relationships.length).toBeGreaterThanOrEqual(2);
      const expectedOwner = classNodeIds.get(
        [...classNodeIds.keys()][0],
      ) as string;
      for (const rel of result.relationships) {
        expect(rel.type).toBe('HAS_METHOD');
        expect(rel.sourceId).toBe(expectedOwner);
        expect(rel.confidence).toBe(1.0);
      }
      expect(result.relationships.every((r) => r.reason.startsWith('lombok-'))).toBe(true);
    });
  });

  describe('boolean naming', () => {
    it('uses isXxx() for primitive boolean fields', () => {
      const tree = parse(`
@Data
public class Config {
    private boolean enabled;
}
`);
      const classNodeIds = ownerMapBySimpleName(tree, FILE_PATH);
      const result = synthesizeLombokAccessors(tree, FILE_PATH, classNodeIds);

      const names = result.symbols.map((s) => s.name).sort();
      expect(names).toEqual(['isEnabled', 'setEnabled']);
    });

    it('uses getXxx() for Boolean (boxed) fields', () => {
      const tree = parse(`
@Data
public class Config {
    private Boolean enabled;
}
`);
      const classNodeIds = ownerMapBySimpleName(tree, FILE_PATH);
      const result = synthesizeLombokAccessors(tree, FILE_PATH, classNodeIds);

      const names = result.symbols.map((s) => s.name).sort();
      expect(names).toEqual(['getEnabled', 'setEnabled']);
    });
  });

  describe('annotation variants', () => {
    it('only generates getters with @Getter', () => {
      const tree = parse(`
@Getter
public class ReadOnly {
    private String value;
}
`);
      const classNodeIds = ownerMapBySimpleName(tree, FILE_PATH);
      const result = synthesizeLombokAccessors(tree, FILE_PATH, classNodeIds);

      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].name).toBe('getValue');
    });

    it('only generates setters with @Setter', () => {
      const tree = parse(`
@Setter
public class WriteOnly {
    private String value;
}
`);
      const classNodeIds = ownerMapBySimpleName(tree, FILE_PATH);
      const result = synthesizeLombokAccessors(tree, FILE_PATH, classNodeIds);

      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].name).toBe('setValue');
    });
  });

  describe('collision and suppression guards', () => {
    it('skips getter when a hand-written method of the same name exists', () => {
      const tree = parse(`
@Data
public class Order {
    private String orderId;

    public String getOrderId() { return orderId; }
}
`);
      const classNodeIds = ownerMapBySimpleName(tree, FILE_PATH);
      const result = synthesizeLombokAccessors(tree, FILE_PATH, classNodeIds);

      // Getter is hand-written → only the setter is synthesized
      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].name).toBe('setOrderId');
    });

    it('does not generate accessors for static fields', () => {
      const tree = parse(`
@Data
public class Constants {
    private static String VERSION = "1.0";
}
`);
      const classNodeIds = ownerMapBySimpleName(tree, FILE_PATH);
      const result = synthesizeLombokAccessors(tree, FILE_PATH, classNodeIds);

      expect(result.symbols).toHaveLength(0);
    });

    it('does not generate setters for final fields (Lombok never does)', () => {
      const tree = parse(`
@Data
public class Order {
    private final String id;
    private String mutable;
}
`);
      const classNodeIds = ownerMapBySimpleName(tree, FILE_PATH);
      const result = synthesizeLombokAccessors(tree, FILE_PATH, classNodeIds);

      const names = result.symbols.map((s) => s.name).sort();
      // final field: getter only; mutable field: getter + setter
      expect(names).toEqual(['getId', 'getMutable', 'setMutable']);
    });

    it('skips getter when @Getter(AccessLevel.NONE) is on a field', () => {
      const tree = parse(`
@Data
public class Order {
    @Getter(AccessLevel.NONE)
    private String secret;
}
`);
      const classNodeIds = ownerMapBySimpleName(tree, FILE_PATH);
      const result = synthesizeLombokAccessors(tree, FILE_PATH, classNodeIds);

      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].name).toBe('setSecret');
    });

    it('skips setter when @Setter(AccessLevel.NONE) is on a field', () => {
      const tree = parse(`
@Data
public class Order {
    @Setter(AccessLevel.NONE)
    private String pinned;
}
`);
      const classNodeIds = ownerMapBySimpleName(tree, FILE_PATH);
      const result = synthesizeLombokAccessors(tree, FILE_PATH, classNodeIds);

      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].name).toBe('getPinned');
    });

    it('returns empty result for classes without Lombok annotations', () => {
      const tree = parse(`
public class PlainClass {
    private String value;
}
`);
      const classNodeIds = ownerMapBySimpleName(tree, FILE_PATH);
      const result = synthesizeLombokAccessors(tree, FILE_PATH, classNodeIds);

      expect(result.symbols).toHaveLength(0);
      expect(result.nodes).toHaveLength(0);
      expect(result.relationships).toHaveLength(0);
    });

    it('skips classes not present in the owner map', () => {
      const tree = parse(`
@Data
public class Order {
    private String orderId;
}
`);
      const classNodeIds = new Map<number, string>(); // empty
      const result = synthesizeLombokAccessors(tree, FILE_PATH, classNodeIds);

      expect(result.symbols).toHaveLength(0);
    });
  });

  describe('nested classes', () => {
    it('handles nested @Data classes', () => {
      const tree = parse(`
public class Outer {
    @Data
    public static class Inner {
        private String value;
    }
}
`);
      const classNodeIds = ownerMapBySimpleName(tree, FILE_PATH);
      const result = synthesizeLombokAccessors(tree, FILE_PATH, classNodeIds);

      // Only Inner has @Data
      expect(result.symbols).toHaveLength(2);
      const names = result.symbols.map((s) => s.name).sort();
      expect(names).toEqual(['getValue', 'setValue']);
    });

    it('keys synthesized ids by the immediate enclosing class (Outer.method, like real nested member ids)', () => {
      const tree = parse(`
public class Outer {
    @Data
    public static class Inner {
        private String value;
    }
}
`);
      const classNodeIds = ownerMapBySimpleName(tree, FILE_PATH);
      const result = synthesizeLombokAccessors(tree, FILE_PATH, classNodeIds);

      const getter = result.symbols.find((s) => s.name === 'getValue')!;
      expect(getter).toBeDefined();
      // Real nested-class method ids are keyed `Inner.method` (immediate
      // parent simple name) — the synthesized id must agree so call
      // resolution can hit it.
      expect(getter.nodeId).toBe('Method:/test/Order.java:Inner.getValue#0');
    });

    it('gives same-tailed nested classes DISTINCT owners (bot: name-keyed map overwrite)', () => {
      const tree = parse(`
public class First {
    @Data
    public static class Item {
        private String a;
    }
}

public class Second {
    @Data
    public static class Item {
        private String b;
    }
}
`);
      // Same-tail `Item` twice in one file — a name-keyed map could only keep
      // one. The AST-node-id key keeps both.
      const classNodeIds = ownerMapBySimpleName(tree, FILE_PATH);
      expect(classNodeIds.size).toBe(4); // First, First.Item, Second, Second.Item

      const result = synthesizeLombokAccessors(tree, FILE_PATH, classNodeIds);

      // Both Items synthesize — a name collision would drop one side.
      // Method ids follow the real convention (keyed by the class's own
      // simple name `Item.method`, matching how real nested-class members
      // key), so the two Items' methods share id shapes but anchor on
      // DIFFERENT class nodes via HAS_METHOD.
      const names = result.symbols.map((s) => s.name).sort();
      expect(names).toEqual(['getA', 'getB', 'setA', 'setB']);

      // And each HAS_METHOD edge anchors on its own class — the owner
      // resolution is what the AST-node-id key fixed.
      const edges = result.relationships.map((r) => `${r.sourceId} -> ${r.targetId}`).sort();
      // Same-named nested classes in one file get a `~N` occurrence suffix on
      // the synthesized id prefix (review P1: name-only prefixes collapsed
      // both getters onto one Method node). A lone nested class keeps the
      // plain shape, byte-identical to real member ids.
      expect(edges).toEqual([
        'Class:/test/Order.java:First.Item -> Method:/test/Order.java:Item~0.getA#0',
        'Class:/test/Order.java:First.Item -> Method:/test/Order.java:Item~0.setA#1',
        'Class:/test/Order.java:Second.Item -> Method:/test/Order.java:Item~1.getB#0',
        'Class:/test/Order.java:Second.Item -> Method:/test/Order.java:Item~1.setB#1',
      ]);
    });
  });

  describe('multi-variable declarations', () => {
    it('handles `int x, y;` style declarations', () => {
      const tree = parse(`
@Data
public class Point {
    private int x, y;
}
`);
      const classNodeIds = ownerMapBySimpleName(tree, FILE_PATH);
      const result = synthesizeLombokAccessors(tree, FILE_PATH, classNodeIds);

      // 2 fields × 2 accessors = 4 methods
      expect(result.symbols).toHaveLength(4);
      const names = result.symbols.map((s) => s.name).sort();
      expect(names).toEqual(['getX', 'getY', 'setX', 'setY']);
    });
  });

  describe('node properties', () => {
    it('marks synthetic methods with synthetic: lombok (non-vacuous)', () => {
      const tree = parse(`
@Data
public class Order {
    private String orderId;
}
`);
      const classNodeIds = ownerMapBySimpleName(tree, FILE_PATH);
      const result = synthesizeLombokAccessors(tree, FILE_PATH, classNodeIds);

      // The loop below must iterate real nodes — assert the counts first so
      // `for..of` over an empty array cannot pass vacuously.
      expect(result.nodes).toHaveLength(2);
      for (const node of result.nodes) {
        expect(node.properties.synthetic).toBe('lombok');
        expect(node.properties.visibility).toBe('public');
        expect(node.properties.isStatic).toBe(false);
      }
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Review regression coverage (magyargergo, 2026-08-29) — each finding gets
// a pinned test so the exact reported trigger stays guarded.
// ═══════════════════════════════════════════════════════════════════════════

describe('review regressions', () => {
  it('P1: primitive boolean isX fields keep isEnabled/setEnabled (Lombok ^is[A-Z] base rule)', () => {
    const tree = parse(`
@Data
public class Flag {
    private boolean isEnabled;
    private boolean active;
    private boolean island;
}
`);
    const owners = ownerMapBySimpleName(tree, FILE_PATH);
    const result = synthesizeLombokAccessors(tree, FILE_PATH, owners);
    const names = result.symbols.map((s) => s.name).sort();
    // `isEnabled` absorbs its `is` prefix (base name `enabled`), so the getter
    // is `isEnabled()` — NOT `isIsEnabled()`, and the setter is `setEnabled`.
    // Plain `active` gets `isActive`. `island` does NOT match ^is[A-Z]
    // (third char is lowercase), so as a boolean it gets `isIsland()` —
    // which is exactly what Lombok emits for it.
    expect(names).toEqual([
      'isIsland', 'setIsland',
      'isActive', 'setEnabled', 'isEnabled', 'setActive',
    ].sort());
  });

  it('P1: boxed Boolean uses get (not is), per Lombok', () => {
    const tree = parse(`
@Data
public class Flag {
    private Boolean enabled;
}
`);
    const owners = ownerMapBySimpleName(tree, FILE_PATH);
    const result = synthesizeLombokAccessors(tree, FILE_PATH, owners);
    expect(result.symbols.map((s) => s.name).sort()).toEqual(['getEnabled', 'setEnabled']);
  });

  it('P1: field-only @Getter (no class-level annotation) still synthesizes', () => {
    const tree = parse(`
public class Item {
    @Getter
    private String value;
    private String other;
}
`);
    const owners = ownerMapBySimpleName(tree, FILE_PATH);
    const result = synthesizeLombokAccessors(tree, FILE_PATH, owners);
    // Only `value` is opted in by the field annotation; `other` stays bare.
    expect(result.symbols.map((s) => s.name)).toEqual(['getValue']);
  });

  it('P1: class-level @Getter(AccessLevel.NONE) disables getters class-wide', () => {
    const tree = parse(`
@Getter(AccessLevel.NONE)
public class A {
    private String x;
    @Getter
    private String y;
}
`);
    const owners = ownerMapBySimpleName(tree, FILE_PATH);
    const result = synthesizeLombokAccessors(tree, FILE_PATH, owners);
    // Class default off entirely; only the field-level opt-in survives.
    expect(result.symbols.map((s) => s.name)).toEqual(['getY']);
  });

  it('P1: non-Lombok qualified annotations are ignored (@com.acme.Data is not Lombok)', () => {
    const tree = parse(`
@com.acme.Data
public class NotLombok {
    private String x;
}
`);
    const owners = ownerMapBySimpleName(tree, FILE_PATH);
    const result = synthesizeLombokAccessors(tree, FILE_PATH, owners);
    expect(result.symbols).toHaveLength(0);
  });

  it('P1: lombok-qualified annotations ARE Lombok (@lombok.Data)', () => {
    const tree = parse(`
@lombok.Data
public class Real {
    private String x;
}
`);
    const owners = ownerMapBySimpleName(tree, FILE_PATH);
    const result = synthesizeLombokAccessors(tree, FILE_PATH, owners);
    expect(result.symbols.map((s) => s.name).sort()).toEqual(['getX', 'setX']);
  });

  it('P2: non-default access levels are emitted as real visibility', () => {
    const tree = parse(`
public class Levels {
    @Getter(AccessLevel.PROTECTED)
    private String prot;
    @Getter(AccessLevel.PRIVATE)
    private String priv;
    @Setter(AccessLevel.PACKAGE)
    private String pkg;
}
`);
    const owners = ownerMapBySimpleName(tree, FILE_PATH);
    const result = synthesizeLombokAccessors(tree, FILE_PATH, owners);
    const byName = new Map(result.symbols.map((s) => [s.name, s]));
    expect(byName.get('getProt')!.visibility).toBe('protected');
    expect(byName.get('getPriv')!.visibility).toBe('private');
    expect(byName.get('setPkg')!.visibility).toBe('package');
  });

  it('P2: hand-written getX(int) overload does NOT suppress zero-arg Lombok getter', () => {
    const tree = parse(`
@Data
public class Overload {
    private String x;
    public String getX(int mode) { return null; }
}
`);
    const owners = ownerMapBySimpleName(tree, FILE_PATH);
    const result = synthesizeLombokAccessors(tree, FILE_PATH, owners);
    // Arity-aware collision: getX(int) is arity 1, the Lombok getter is
    // arity 0 — both coexist in Java, so the getter must be synthesized.
    expect(result.symbols.map((s) => s.name)).toContain('getX');
  });

  it('P2: hand-written zero-arg getX DOES suppress the Lombok getter', () => {
    const tree = parse(`
@Data
public class Real {
    private String x;
    public String getX() { return "hand"; }
}
`);
    const owners = ownerMapBySimpleName(tree, FILE_PATH);
    const result = synthesizeLombokAccessors(tree, FILE_PATH, owners);
    expect(result.symbols.map((s) => s.name)).not.toContain('getX');
    expect(result.symbols.map((s) => s.name)).toContain('setX');
  });
});
