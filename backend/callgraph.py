# -*- coding: utf-8 -*-
"""
函数调用图（Function Call Graph）构建。

数据完全来自语义分析阶段的解析结果，而不是按名字硬连：
  * 节点——语义分析注册到全局作用域的函数符号（KIND_FUNCTION）、
    被调用到的内置函数（KIND_BUILTIN），以及代表顶层语句的虚拟节点 ``<main>``；
  * 边——``SemanticAnalyzer.call_sites`` 里记录的每一个调用点，其目标是
    作用域查找后绑定的符号，因此同名、被局部变量/形参遮蔽的名字不会连错。

图上额外给出：
  * 从未被调用的用户函数（入度为 0，``<main>`` 视为程序入口不计入）；
  * 递归（自环）与间接递归（强连通分量，SCC）；
  * 无法成边的调用点：未定义名字、解析到非可调用对象（变量/形参）、
    目标无法静态确定的间接调用。
"""

from . import ast_nodes as ast
from . import symbols as sym
from . import semantic as semantic_mod

MAIN_NODE = "<main>"


class CallGraphBuilder:
    def __init__(self, program: ast.Program, analyzer: "semantic_mod.SemanticAnalyzer"):
        self.program = program
        self.analyzer = analyzer
        self.nodes = []          # List[dict]，按声明顺序输出
        self._index = {}         # id -> node
        self.edges = []          # List[dict]
        self.unresolved = []     # 无法成边的调用点

    # ------------------------------------------------------------------
    def build(self):
        self._make_nodes()
        self._make_edges()
        self._compute_indegrees()
        self._find_recursion()
        return self.to_dict()

    # ------------------------------------------------------------------
    def _make_nodes(self):
        # 顶层代码入口（codegen 中对应的 <main> 函数）
        self._add_node(MAIN_NODE, "main", line=1, column=1,
                       label="<main>", detail="顶层语句（程序入口）", params=[])
        # 用户函数：只取语义分析成功注册到全局作用域的函数符号，
        # 声明元信息（参数/位置）从 AST 的 FunctionDecl 补全。
        decls = {}
        for decl in self.program.declarations:
            if isinstance(decl, ast.FunctionDecl):
                decls.setdefault(decl.name, decl)
        for s in self.analyzer.symbols.global_scope.symbols.values():
            if s.kind != sym.KIND_FUNCTION:
                continue
            decl = decls.get(s.name)
            params = list(decl.params) if decl else []
            self._add_node(s.name, "function", line=s.line, column=s.column,
                           label=s.name, detail="用户函数", params=params)
        # 内置函数节点按需创建（仅被调用到的）
        for site in self.analyzer.call_sites:
            if site["kind"] == sym.KIND_BUILTIN and site["target"] not in self._index:
                self._add_node(site["target"], "builtin", line=0, column=0,
                               label=site["target"], detail="内置函数", params=[])

    def _add_node(self, node_id, kind, line, column, label, detail, params):
        node = {
            "id": node_id, "kind": kind, "label": label, "detail": detail,
            "params": params, "line": line, "column": column,
            "indegree": 0, "outdegree": 0, "called": kind == "main",
            "recursive": False,
        }
        self.nodes.append(node)
        self._index[node_id] = node
        return node

    # ------------------------------------------------------------------
    def _make_edges(self):
        merged = {}  # (caller, target) -> edge
        for site in self.analyzer.call_sites:
            kind = site["kind"]
            if kind not in (sym.KIND_FUNCTION, sym.KIND_BUILTIN):
                self.unresolved.append({
                    "caller": site["caller"], "kind": kind,
                    "name": site["name"], "line": site["line"],
                    "column": site["column"],
                })
                continue
            caller, target = site["caller"], site["target"]
            if caller not in self._index:
                # 调用点位于未被识别的嵌套函数声明内（语言当前不支持嵌套函数注册）
                self._add_node(caller, "function", line=site["line"],
                               column=site["column"], label=caller,
                               detail="用户函数", params=[])
            if target not in self._index:
                continue
            key = (caller, target)
            edge = merged.get(key)
            if edge is None:
                edge = {
                    "source": caller, "target": target,
                    "kind": "builtin" if kind == sym.KIND_BUILTIN else "call",
                    "count": 0, "sites": [],
                    "self_loop": caller == target,
                }
                merged[key] = edge
                self.edges.append(edge)
            edge["count"] += 1
            edge["sites"].append({
                "line": site["line"], "column": site["column"],
                "synthetic": site["synthetic"],
            })

    def _compute_indegrees(self):
        # 入度 / 出度按去重后的边计算（自环两边各计一次）
        for e in self.edges:
            self._index[e["source"]]["outdegree"] += 1
            self._index[e["target"]]["indegree"] += 1
        for n in self.nodes:
            if n["kind"] == "function":
                n["called"] = n["indegree"] > 0

    # ------------------------------------------------------------------
    def _find_recursion(self):
        """Tarjan 强连通分量：大小 >=2 的 SCC 即间接递归；
        大小为 1 但带自环的即直接递归。"""
        adj = {n["id"]: [] for n in self.nodes}
        for e in self.edges:
            adj[e["source"]].append(e["target"])
        index_counter = [0]
        stack, on_stack, indices, lowlink = [], set(), {}, {}
        groups = []

        def strongconnect(v):
            indices[v] = index_counter[0]
            lowlink[v] = index_counter[0]
            index_counter[0] += 1
            stack.append(v)
            on_stack.add(v)
            for w in adj[v]:
                if w not in indices:
                    strongconnect(w)
                    lowlink[v] = min(lowlink[v], lowlink[w])
                elif w in on_stack:
                    lowlink[v] = min(lowlink[v], indices[w])
            if lowlink[v] == indices[v]:
                comp = []
                while True:
                    w = stack.pop()
                    on_stack.discard(w)
                    comp.append(w)
                    if w == v:
                        break
                groups.append(comp)

        for nid in adj:
            if nid not in indices:
                strongconnect(nid)

        self_loops = {e["source"] for e in self.edges if e["self_loop"]}
        recursive_groups = []
        for comp in groups:
            is_self = len(comp) == 1 and comp[0] in self_loops
            if len(comp) >= 2 or is_self:
                members = sorted(comp)
                for m in members:
                    self._index[m]["recursive"] = True
                recursive_groups.append({
                    "members": members,
                    "kind": "self" if is_self else "mutual",
                })
        self.recursive_groups = recursive_groups

    # ------------------------------------------------------------------
    def to_dict(self):
        # called/indegree 以最终去重后的边为准（主节点恒为入口）
        uncalled = [n["id"] for n in self.nodes
                    if n["kind"] == "function" and n["indegree"] == 0]
        builtins = [n["id"] for n in self.nodes if n["kind"] == "builtin"]
        return {
            "nodes": self.nodes,
            "edges": self.edges,
            "unresolved": self.unresolved,
            "recursive_groups": self.recursive_groups,
            "stats": {
                "function_count": sum(1 for n in self.nodes if n["kind"] == "function"),
                "builtin_count": len(builtins),
                "edge_count": len(self.edges),
                "uncalled_count": len(uncalled),
                "recursive_count": sum(1 for n in self.nodes if n["recursive"]),
                "unresolved_count": len(self.unresolved),
            },
            "uncalled": uncalled,
        }


def build_call_graph(program, analyzer):
    return CallGraphBuilder(program, analyzer).build()
