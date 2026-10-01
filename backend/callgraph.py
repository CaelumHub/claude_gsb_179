# -*- coding: utf-8 -*-
"""
函数调用图（Call Graph）构建器。

输入 MiniLang 源码，经「词法 -> 语法 -> 语义」流水线后，直接复用语义分析
已经解析好的调用目标（``CallExpr.callee.symbol``），得到函数节点与调用边：

  * 用户函数节点来自顶层 ``FunctionDecl``；
  * 内置函数节点（print/len/range/...）按需出现——只收录真正被调用的；
  * ``<main>`` 是虚拟节点，表示顶层语句（程序入口）；
  * 每条边记录全部调用点（行/列），同名函数之间多次调用聚合为一条边；
  * 自环（直接递归）与间接递归（强连通分量）都会标出；
  * 入度为 0 的用户函数标记为 ``uncalled``（从未被任何代码调用）。

关键的一点：连线依据的是语义分析对名字的解析结果（符号对象的 kind），
而不是调用处写的名字文本。因此当一个名字被局部变量/形参遮蔽后，该处调用
不会错误地连到同名函数上；解析不到目标的调用会进入 ``unresolved`` 列表，
而不是"猜"一个同名节点连过去。
"""

import sys

from . import ast_nodes as ast
from . import lexer as lexer_mod
from . import parser as parser_mod
from . import semantic as semantic_mod
from . import symbols as sym

MAIN_ID = "<main>"
MAIN_NAME = "<顶层入口>"


class CallGraphBuilder:
    def __init__(self):
        self.nodes = {}          # id -> node dict
        self.user_ids = []       # 用户函数 id（按声明顺序）
        self.edges = {}          # (src, dst) -> edge dict
        self.unresolved = []     # 无法静态解析到函数目标的调用
        self._sym_to_id = {}     # Symbol 对象 id() -> 节点 id
        self._builtin_ids = {}   # 内置名 -> 节点 id
        self._owner_stack = []   # 当前遍历所在函数节点 id（空则为顶层）

    # ------------------------------------------------------------------
    # 入口
    # ------------------------------------------------------------------
    def build(self, source: str) -> dict:
        tokens, lex_diags = lexer_mod.tokenize(source)
        diags = lex_diags
        if lex_diags.has_errors:
            return self._result(False, "lexed", diags.to_list())

        parser = parser_mod.Parser(tokens, diags)
        program = parser.parse()
        if diags.has_errors:
            return self._result(False, "parsed", diags.to_list())

        analyzer = semantic_mod.SemanticAnalyzer()
        analyzer.set_source(source)
        analyzer.analyze(program)
        sem_diags = analyzer.diagnostics.to_list()

        # 1) 为每个用户函数声明建节点，并登记 符号 -> 节点
        for decl in program.declarations:
            if isinstance(decl, ast.FunctionDecl):
                self._add_user_node(decl)

        # 2) 顶层语句只要存在，就建 <main> 虚拟入口节点
        has_toplevel = any(isinstance(d, ast.Stmt) for d in program.declarations)
        if has_toplevel:
            self.nodes[MAIN_ID] = {
                "id": MAIN_ID, "name": MAIN_NAME, "kind": "main",
                "line": 1, "column": 1, "arity": None,
            }

        # 3) 遍历全部语句/表达式，按语义解析结果收集调用边
        for decl in program.declarations:
            if isinstance(decl, ast.FunctionDecl):
                self._owner_stack.append(self._sym_to_id.get(id(decl.symbol)))
                self._walk_stmt(decl.body)
                self._owner_stack.pop()
            else:
                self._owner_stack.clear()
                self._walk_stmt(decl)

        # 4) 后处理：入度、自环、间接递归、从未被调用
        self._postprocess()

        return self._result(True, "analyzed", sem_diags)

    # ------------------------------------------------------------------
    # 节点
    # ------------------------------------------------------------------
    def _add_user_node(self, fn: ast.FunctionDecl):
        node_id = f"user@{fn.line}:{fn.column}:{fn.name}"
        self.user_ids.append(node_id)
        self.nodes[node_id] = {
            "id": node_id, "name": fn.name, "kind": "user",
            "line": fn.line, "column": fn.column, "arity": len(fn.params),
        }
        if fn.symbol is not None:
            self._sym_to_id[id(fn.symbol)] = node_id

    def _builtin_node(self, name: str) -> str:
        node_id = self._builtin_ids.get(name)
        if node_id is None:
            sig = semantic_mod.BUILTIN_SIGNATURES.get(name)
            node_id = f"builtin:{name}"
            self._builtin_ids[name] = node_id
            self.nodes[node_id] = {
                "id": node_id, "name": name, "kind": "builtin",
                "line": 0, "column": 0, "arity": sig,
            }
        return node_id

    # ------------------------------------------------------------------
    # 调用边
    # ------------------------------------------------------------------
    @property
    def _owner(self):
        return self._owner_stack[-1] if self._owner_stack else MAIN_ID

    def _record_call(self, target_id, line, column, name):
        src = self._owner
        # 顶层调用 <main> 节点可能因为没有顶层 Stmt 而不存在（理论上不会发生）
        if src not in self.nodes:
            self.nodes[src] = {"id": src, "name": MAIN_NAME, "kind": "main",
                               "line": 1, "column": 1, "arity": None}
        key = (src, target_id)
        edge = self.edges.get(key)
        if edge is None:
            edge = {"source": src, "target": target_id, "calls": []}
            self.edges[key] = edge
        edge["calls"].append({"line": line, "column": column, "name": name})

    def _record_unresolved(self, name, line, column, reason):
        self.unresolved.append({"name": name, "line": line, "column": column, "reason": reason})

    def _resolve_call(self, e: ast.CallExpr):
        # 先遍历实参（实参表达式里可能还套着别的调用）
        for a in e.args:
            self._walk_expr(a)

        callee = e.callee
        if isinstance(callee, ast.Identifier):
            s = callee.symbol  # 语义分析的解析结果
            if s is None:
                self._record_unresolved(callee.name, callee.line, callee.column,
                                        "未定义的名字")
                return
            if s.kind == sym.KIND_FUNCTION:
                target = self._sym_to_id.get(id(s))
                if target is None:
                    # 正常不会发生：函数符号一定来自某个 FunctionDecl
                    self._record_unresolved(s.name, callee.line, callee.column,
                                            "函数声明未登记")
                else:
                    self._record_call(target, callee.line, callee.column, s.name)
                return
            if s.kind == sym.KIND_BUILTIN:
                self._record_call(self._builtin_node(s.name),
                                  callee.line, callee.column, s.name)
                return
            # 名字解析到了变量/形参等：这是"被遮蔽"的情形，绝不按名字连到函数
            self._record_unresolved(callee.name, callee.line, callee.column,
                                    f"该名字在此处解析为{_kind_text(s.kind)}，不是函数（可能被同名变量/形参遮蔽）")
            return
        # 非标识符调用（动态 callee，如变量保存的函数值），语义层不做目标解析
        self._walk_expr(callee)
        self._record_unresolved("(动态调用)", e.line, e.column,
                                "调用目标不是标识符，无法静态解析")

    # ------------------------------------------------------------------
    # AST 遍历（覆盖 ast_nodes 中全部语句/表达式类型，含嵌套函数声明）
    # ------------------------------------------------------------------
    def _walk_block(self, block: ast.Block):
        for s in block.statements:
            self._walk_stmt(s)

    def _walk_stmt(self, s):
        if s is None:
            return
        if isinstance(s, ast.Block):
            self._walk_block(s)
        elif isinstance(s, ast.VarDecl):
            if s.initializer:
                self._walk_expr(s.initializer)
        elif isinstance(s, ast.AssignStmt):
            if isinstance(s.target, ast.IndexExpr):
                self._walk_expr(s.target.target)
                self._walk_expr(s.target.index)
            self._walk_expr(s.value)
        elif isinstance(s, ast.ExprStmt):
            self._walk_expr(s.expr)
        elif isinstance(s, ast.PrintStmt):
            for a in s.args:
                self._walk_expr(a)
            # print 语句等价于对内置 print 的调用（codegen 也是如此处理）
            self._record_call(self._builtin_node("print"), s.line, s.column, "print")
        elif isinstance(s, ast.IfStmt):
            for cond, body in s.branches:
                self._walk_expr(cond)
                self._walk_block(body)
            if s.else_block:
                self._walk_block(s.else_block)
        elif isinstance(s, ast.WhileStmt):
            self._walk_expr(s.condition)
            self._walk_block(s.body)
        elif isinstance(s, ast.ForStmt):
            if s.init:
                self._walk_stmt(s.init)
            if s.condition:
                self._walk_expr(s.condition)
            if s.increment:
                self._walk_expr(s.increment)
            self._walk_block(s.body)
        elif isinstance(s, ast.ReturnStmt):
            if s.value:
                self._walk_expr(s.value)
        elif isinstance(s, ast.FunctionDecl):
            # 语言当前只在顶层解析函数声明，嵌套声明仍按节点遍历，保证不漏调用
            nested = self._sym_to_id.get(id(s.symbol))
            if nested is None:
                self._add_user_node(s)
                nested = self._sym_to_id.get(id(s.symbol))
            self._owner_stack.append(nested)
            self._walk_block(s.body)
            self._owner_stack.pop()
        # Break / Continue 无表达式

    def _walk_expr(self, e):
        if e is None:
            return
        if isinstance(e, ast.CallExpr):
            self._resolve_call(e)
        elif isinstance(e, ast.UnaryExpr):
            self._walk_expr(e.operand)
        elif isinstance(e, ast.BinaryExpr):
            self._walk_expr(e.left)
            self._walk_expr(e.right)
        elif isinstance(e, ast.LogicalExpr):
            self._walk_expr(e.left)
            self._walk_expr(e.right)
        elif isinstance(e, ast.IndexExpr):
            self._walk_expr(e.target)
            self._walk_expr(e.index)
        elif isinstance(e, ast.ListLiteral):
            for x in e.elements:
                self._walk_expr(x)
        # 字面量 / Identifier 不含调用

    # ------------------------------------------------------------------
    # 后处理：入度 / 递归环 / 未调用标记
    # ------------------------------------------------------------------
    def _postprocess(self):
        indeg = {nid: 0 for nid in self.nodes}
        outdeg = {nid: 0 for nid in self.nodes}
        adj = {nid: [] for nid in self.nodes}
        for (src, dst) in self.edges:
            indeg[dst] = indeg.get(dst, 0) + 1
            outdeg[src] = outdeg.get(src, 0) + 1
            adj.setdefault(src, []).append(dst)

        # 自环（直接递归）
        for (src, dst), edge in self.edges.items():
            edge["self_loop"] = src == dst

        # 间接递归：用户函数构成的强连通分量（Tarjan），大小>1 即环
        recursive = set()
        for members in _tarjan_scc({n: adj.get(n, []) for n in self.user_ids}):
            if len(members) > 1:
                recursive.update(members)
        # 环上节点发出的边标记 in_cycle
        for (src, dst), edge in self.edges.items():
            edge["in_cycle"] = src in recursive and dst in recursive

        for nid, node in self.nodes.items():
            node["in_degree"] = indeg.get(nid, 0)
            node["out_degree"] = outdeg.get(nid, 0)
            node["self_recursive"] = any(k[0] == nid and k[1] == nid for k in self.edges)
            node["mutually_recursive"] = nid in recursive
            if node["kind"] == "user":
                # 从未被调用：用户函数且没有任何入边（含 <main> 与其它函数）
                node["uncalled"] = indeg.get(nid, 0) == 0
            else:
                node["uncalled"] = False

    # ------------------------------------------------------------------
    # 输出
    # ------------------------------------------------------------------
    def _result(self, ok, stage, diagnostics):
        # 用户函数在前（声明序），其后 <main>，内置函数按名字排序
        ordered = [self.nodes[i] for i in self.user_ids if i in self.nodes]
        if MAIN_ID in self.nodes:
            ordered.append(self.nodes[MAIN_ID])
        for name in sorted(self._builtin_ids):
            ordered.append(self.nodes[self._builtin_ids[name]])
        edges = list(self.edges.values())
        edges.sort(key=lambda e: (e["source"], e["target"]))
        uncalled = [n["id"] for n in ordered if n.get("uncalled")]
        return {
            "ok": ok,
            "stage": stage,
            "diagnostics": diagnostics,
            "nodes": ordered,
            "edges": edges,
            "unresolved": self.unresolved,
            "stats": {
                "user_count": len(self.user_ids),
                "builtin_count": len(self._builtin_ids),
                "edge_count": len(edges),
                "uncalled_count": len(uncalled),
                "recursive_count": sum(1 for n in ordered
                                       if n.get("self_recursive") or n.get("mutually_recursive")),
                "unresolved_count": len(self.unresolved),
            },
        }


def _kind_text(kind: str) -> str:
    return {
        sym.KIND_VARIABLE: "变量",
        sym.KIND_PARAMETER: "形参",
        sym.KIND_FUNCTION: "函数",
        sym.KIND_BUILTIN: "内置函数",
    }.get(kind, kind)


def _tarjan_scc(adj):
    """返回强连通分量列表（每个分量为节点集合列表）。"""
    index = 0
    stack = []
    on_stack = set()
    indices = {}
    low = {}
    sccs = []

    def strongconnect(v, _index):
        indices[v] = _index
        low[v] = _index
        _index += 1
        stack.append(v)
        on_stack.add(v)
        for w in adj.get(v, []):
            if w not in indices:
                _index = strongconnect(w, _index)
                low[v] = min(low[v], low[w])
            elif w in on_stack:
                low[v] = min(low[v], indices[w])
        if low[v] == indices[v]:
            comp = []
            while True:
                w = stack.pop()
                on_stack.discard(w)
                comp.append(w)
                if w == v:
                    break
            sccs.append(comp)
        return _index

    sys.setrecursionlimit(max(1000, len(adj) * 4 + 100))
    idx = 0
    for v in list(adj):
        if v not in indices:
            idx = strongconnect(v, idx)
    return sccs


def build_call_graph(source: str) -> dict:
    """构建函数调用图，返回供前端"函数调用图"页面使用的结构化结果。"""
    return CallGraphBuilder().build(source)
