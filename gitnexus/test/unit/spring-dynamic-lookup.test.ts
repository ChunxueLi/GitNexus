/**
 * Unit + integration test: Spring dynamic bean lookup heuristic.
 *
 * The extraction-logic cases import the PRODUCTION `extractDynamicLookups`
 * (previously this suite re-implemented the regex locally, so a change to the
 * production pattern or the scope-resolver hook left the suite green — the
 * exact P1 from review). The integration block below drives the real
 * `attachJavaSpringDynamicLookup` against an in-memory KnowledgeGraph and
 * asserts the emitted INJECTS edges and their omissions.
 */
import { describe, it, expect } from 'vitest';
import {
  extractDynamicLookups,
  attachJavaSpringDynamicLookup,
} from '../../src/core/ingestion/languages/java/spring-dynamic-lookup.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import type { ParsedFile } from 'gitnexus-shared';

describe('extractDynamicLookups (production import)', () => {
  it('detects SpringContextUtil.getBeans(X.class) as collection lookup', () => {
    const code = `
      Map<String, OrderService> beans = SpringContextUtil.getBeans(OrderService.class);
    `;
    const sites = extractDynamicLookups(code, 'fn-1');
    expect(sites).toHaveLength(1);
    expect(sites[0].typeName).toBe('OrderService');
    expect(sites[0].isCollection).toBe(true);
  });

  it('detects SpringContextUtil.getBean(X.class) as single lookup', () => {
    const code = `
      RedisAbility redis = SpringContextUtil.getBean(RedisAbility.class);
    `;
    const sites = extractDynamicLookups(code, 'fn-1');
    expect(sites).toHaveLength(1);
    expect(sites[0].typeName).toBe('RedisAbility');
    expect(sites[0].isCollection).toBe(false);
  });

  it('detects getBeansOfType variant', () => {
    const code = `
      Map<String, Factory> map = SpringContextUtil.getBeansOfType(Factory.class);
    `;
    const sites = extractDynamicLookups(code, 'fn-1');
    expect(sites).toHaveLength(1);
    expect(sites[0].typeName).toBe('Factory');
    expect(sites[0].isCollection).toBe(true);
  });

  it('detects applicationContext.getBeans(X.class)', () => {
    const code = `
      Map<String, Plugin> plugins = applicationContext.getBeans(Plugin.class);
    `;
    const sites = extractDynamicLookups(code, 'fn-1');
    expect(sites).toHaveLength(1);
    expect(sites[0].typeName).toBe('Plugin');
  });

  it('detects ctx.getBean(X.class)', () => {
    const code = `
      Service svc = ctx.getBean(Service.class);
    `;
    const sites = extractDynamicLookups(code, 'fn-1');
    expect(sites).toHaveLength(1);
    expect(sites[0].typeName).toBe('Service');
  });

  it('skips unknown receivers', () => {
    const code = `
      Map<String, X> map = someRandomHelper.getBeans(X.class);
    `;
    const sites = extractDynamicLookups(code, 'fn-1');
    expect(sites).toHaveLength(0);
  });

  it('skips getBean(String) — string argument, not .class', () => {
    const code = `
      Object bean = SpringContextUtil.getBean("myBean");
    `;
    const sites = extractDynamicLookups(code, 'fn-1');
    expect(sites).toHaveLength(0);
  });

  it('detects multiple lookups in the same function', () => {
    const code = `
      Map<String, A> aMap = SpringContextUtil.getBeans(A.class);
      B b = SpringContextUtil.getBean(B.class);
      Map<String, C> cMap = ctx.getBeansOfType(C.class);
    `;
    const sites = extractDynamicLookups(code, 'fn-1');
    expect(sites).toHaveLength(3);
    expect(sites.map((s) => s.typeName).sort()).toEqual(['A', 'B', 'C']);
  });

  it('handles getBeans with extra whitespace', () => {
    const code = `
      Map<String, X> map = SpringContextUtil.getBeans(  X.class  );
    `;
    const sites = extractDynamicLookups(code, 'fn-1');
    expect(sites).toHaveLength(1);
    expect(sites[0].typeName).toBe('X');
  });

  it('does not match getBean without .class argument', () => {
    const code = `
      Object x = SpringContextUtil.getBean();
    `;
    const sites = extractDynamicLookups(code, 'fn-1');
    expect(sites).toHaveLength(0);
  });

  it('does not match unrelated methods like getContext', () => {
    const code = `
      ApplicationContext ctx = SpringContextUtil.getContext();
    `;
    const sites = extractDynamicLookups(code, 'fn-1');
    expect(sites).toHaveLength(0);
  });

  it('handles stream-style getBeans usage', () => {
    const code = `
      List<Service> services = SpringContextUtil.getBeans(Service.class)
          .values().stream().collect(Collectors.toList());
    `;
    const sites = extractDynamicLookups(code, 'fn-1');
    expect(sites).toHaveLength(1);
    expect(sites[0].typeName).toBe('Service');
    expect(sites[0].isCollection).toBe(true);
  });
});

describe('attachJavaSpringDynamicLookup (integration, real graph)', () => {
  const FILE = 'src/main/java/demo/Registry.java';

  /** Source with one interface, two implementer classes, one caller method. */
  const SOURCE = [
    'package demo;',                                     // 1
    'public class Registry {',                           // 2
    '  public void warmup() {',                          // 3  ← method node lines 3-7
    '    Map<String, Payment> ps = SpringContextUtil.getBeans(Payment.class);', // 4
    '    Payment p = ctx.getBean(Payment.class);',       // 5
    '    Object mystery = helper.getBeans(Unknown.class);', // 6 (unknown receiver)
    '  }',                                               // 7
    '}',                                                 // 8
  ].join('\n');

  /**
   * Build the minimal graph the attacher consumes: an Interface `Payment`,
   * two implementers, the caller Method with a line range that covers the
   * lookup calls, and the IMPLEMENTS edges the implementers index reads.
   */
  function buildGraph() {
    const graph = createKnowledgeGraph();
    graph.addNode({
      id: 'Interface:demo/Payment',
      label: 'Interface',
      properties: { name: 'Payment', filePath: FILE, startLine: 1, endLine: 1 },
    });
    graph.addNode({
      id: 'Class:demo/AliPay',
      label: 'Class',
      properties: { name: 'AliPay', filePath: FILE, startLine: 1, endLine: 1 },
    });
    graph.addNode({
      id: 'Class:demo/WeChatPay',
      label: 'Class',
      properties: { name: 'WeChatPay', filePath: FILE, startLine: 1, endLine: 1 },
    });
    graph.addNode({
      id: 'Method:demo/Registry:warmup',
      label: 'Method',
      properties: { name: 'warmup', filePath: FILE, startLine: 3, endLine: 7 },
    });
    graph.addRelationship({
      id: 'IMPLEMENTS:AliPay->Payment',
      sourceId: 'Class:demo/AliPay',
      targetId: 'Interface:demo/Payment',
      type: 'IMPLEMENTS',
      confidence: 1,
    });
    graph.addRelationship({
      id: 'IMPLEMENTS:WeChatPay->Payment',
      sourceId: 'Class:demo/WeChatPay',
      targetId: 'Interface:demo/Payment',
      type: 'IMPLEMENTS',
      confidence: 1,
    });
    return graph;
  }

  const fileContents = new Map<string, string>([[FILE, SOURCE]]);
  const parsedFiles: readonly ParsedFile[] = [];

  function injectsEdges(graph: ReturnType<typeof createKnowledgeGraph>) {
    return [...graph.iterRelationshipsByType('INJECTS')].map((r) => ({
      source: r.sourceId,
      target: r.targetId,
      reason: r.reason,
    }));
  }

  it('emits INJECTS from the calling method to every implementer of the looked-up interface', () => {
    const graph = buildGraph();
    attachJavaSpringDynamicLookup(graph, parsedFiles, fileContents);

    const edges = injectsEdges(graph);
    // Both lookup sites (getBeans + getBean) fan out to the same 2 implementers,
    // but relationship ids are deterministic per (caller→implementer) pair, so
    // the graph holds one edge per unique pair = 2 edges.
    expect(edges).toHaveLength(2);
    const targets = edges.map((e) => e.target).sort();
    expect(targets).toEqual(['Class:demo/AliPay', 'Class:demo/WeChatPay']);
    for (const e of edges) {
      expect(e.source).toBe('Method:demo/Registry:warmup');
      expect(e.reason).toContain('Payment');
    }
  });

  it('omits INJECTS when the receiver is not a known context holder', () => {
    const graph = buildGraph();
    const source = SOURCE.replace('SpringContextUtil.getBeans', 'randomHelper.getBeans')
      .replace('ctx.getBean', 'other.getBean');
    attachJavaSpringDynamicLookup(
      graph,
      parsedFiles,
      new Map([[FILE, source]]),
    );
    expect(injectsEdges(graph)).toHaveLength(0);
  });

  it('omits INJECTS when the looked-up type has no implementers', () => {
    const graph = buildGraph();
    const source = SOURCE.replaceAll('Payment.class', 'Lonely.class');
    attachJavaSpringDynamicLookup(
      graph,
      parsedFiles,
      new Map([[FILE, source]]),
    );
    expect(injectsEdges(graph)).toHaveLength(0);
  });

  it('is a no-op when the function source is not available', () => {
    const graph = buildGraph();
    attachJavaSpringDynamicLookup(graph, parsedFiles, new Map());
    expect(injectsEdges(graph)).toHaveLength(0);
  });
});
