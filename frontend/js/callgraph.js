/* ============================================================
   MiniLang 平台 —— 函数调用图页面
   纯标准前端：SVG + 手写力导向布局（不引入任何第三方依赖）。
   数据来自 /api/compile（detail=callgraph），边由后端语义分析
   按作用域解析后给出，遮蔽 / 同名不会连错。
   ============================================================ */
(function () {
  "use strict";

  ML.Shell.render("callgraph");
  ML.Shell.setTitle("函数调用图");

  const SVGNS = "http://www.w3.org/2000/svg";
  const esc = ML.escapeHtml;

  const editor = new ML.CodeEditor(document.getElementById("editor"), {
    value: ML.store.get("draft_source", ML.DEFAULT_CODE), height: 220,
  });

  const sampleSel = document.getElementById("sample");
  sampleSel.innerHTML = '<option value="">— 载入示例 —</option>' +
    ML.SAMPLES.map((s, i) => `<option value="${i}">${esc(s.name)}</option>`).join("");
  sampleSel.onchange = () => {
    if (sampleSel.value === "") return;
    editor.setValue(ML.SAMPLES[+sampleSel.value].code);
    sampleSel.value = "";
  };
  document.getElementById("btn-loadproj").onclick = async () =>
    editor.setValue(await ML.Shell.loadSource(ML.DEFAULT_CODE));

  const wrap = document.getElementById("cg-wrap");
  const svg = document.getElementById("cg-svg");
  const viewport = document.getElementById("cg-viewport");
  const gEdges = document.createElementNS(SVGNS, "g");
  const gNodes = document.createElementNS(SVGNS, "g");
  viewport.appendChild(gEdges);
  viewport.appendChild(gNodes);

  const UNRESOLVED_TEXT = {
    undefined: "未定义名字（语义错误，未连成边）",
    not_callable: "名字解析到变量/形参，不是函数（可能被遮蔽）",
    indirect: "间接调用，目标无法静态确定",
  };

  let graph = null;          // 后端返回的 callgraph
  let nodes = [];            // 布局节点 {id,data,x,y,vx,vy,w,h,el}
  let nodeMap = new Map();
  let edges = [];            // {data, src, dst, el, labelEl}
  let selectedId = null;
  let transform = { x: 0, y: 0, k: 1 };

  /* ----------------------------------------------------------
   * 编译并生成
   * ---------------------------------------------------------- */
  async function build() {
    const code = editor.getValue();
    ML.store.set("draft_source", code);
    const data = await ML.api.compile(code, "callgraph");
    const r = data.result || {};
    if (!r.has_callgraph || !r.callgraph) {
      gEdges.innerHTML = ""; gNodes.innerHTML = "";
      graph = null;
      document.getElementById("cg-stats").textContent = "";
      document.getElementById("cg-uncalled").innerHTML =
        `<div class="empty"><div class="big">🚫</div>无法生成调用图（语法分析未通过）。<br><a href="diagnostics.html">前往诊断页查看错误</a></div>`;
      document.getElementById("cg-notes").innerHTML =
        ML.empty("修复语法错误后重新生成调用图");
      return;
    }
    graph = r.callgraph;
    selectedId = null;
    document.getElementById("cg-detail").classList.remove("open");
    layout(true);
    renderAll();
    renderPanels();
  }

  document.getElementById("btn-build").onclick = build;
  document.getElementById("btn-relayout").onclick = () => { if (graph) { layout(true); renderAll(); } };
  document.getElementById("chk-builtins").onchange = () => { if (graph) { layout(false); renderAll(); } };
  document.getElementById("chk-labels").onchange = renderAll;
  document.getElementById("btn-zoom-in").onclick = () => zoomAt(1.2);
  document.getElementById("btn-zoom-out").onclick = () => zoomAt(1 / 1.2);
  document.getElementById("btn-zoom-fit").onclick = fit;

  /* ----------------------------------------------------------
   * 力导向布局（静态模拟若干轮后收敛）
   * ---------------------------------------------------------- */
  function nodeTextLines(data) {
    if (data.kind === "main") return ["<main>", "顶层入口"];
    if (data.kind === "builtin") return [data.label];
    return [`${data.label}(${data.params.join(", ")})`, `L${data.line}`];
  }

  function measure(data) {
    const lines = nodeTextLines(data);
    const w = Math.max(78, Math.max.apply(null, lines.map((t) => t.length)) * 7.8 + 26);
    const h = lines.length >= 2 ? 42 : 32;
    return { w, h, lines };
  }

  function showBuiltins() { return document.getElementById("chk-builtins").checked; }

  function visibleNodes() {
    return nodes.filter((n) => showBuiltins() || n.data.kind !== "builtin");
  }

  function layout(randomize) {
    const W = Math.max(wrap.clientWidth, 400);
    const H = Math.max(wrap.clientHeight, 300);
    nodes = graph.nodes.map((data) => {
      const m = measure(data);
      return Object.assign({
        id: data.id, data, x: 0, y: 0, vx: 0, vy: 0, el: null,
      }, m);
    });
    nodeMap = new Map(nodes.map((n) => [n.id, n]));

    const vis = visibleNodes();
    const visSet = new Set(vis.map((n) => n.id));
    edges = graph.edges
      .filter((e) => visSet.has(e.source) && visSet.has(e.target))
      .map((data) => ({ data, src: nodeMap.get(data.source), dst: nodeMap.get(data.target), el: null }));

    // 初始位置：环形 + 抖动（重新布局时换一组随机相位）
    const cx = W / 2, cy = H / 2;
    const phase = randomize ? Math.random() * Math.PI * 2 : 0;
    vis.forEach((n, i) => {
      const a = phase + (i / Math.max(vis.length, 1)) * Math.PI * 2;
      n.x = cx + Math.cos(a) * 200;
      n.y = cy + Math.sin(a) * 150;
      n.vx = (Math.random() - 0.5) * 20;
      n.vy = (Math.random() - 0.5) * 20;
    });

    const SPRING = 0.025, REP = 5200, GRAV = 0.018, DAMP = 0.86;
    for (let tick = 0; tick < 420; tick++) {
      // 斥力（节点少，O(n²) 足够）
      for (let i = 0; i < vis.length; i++) {
        for (let j = i + 1; j < vis.length; j++) {
          const a = vis[i], b = vis[j];
          let dx = a.x - b.x, dy = a.y - b.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 1) { dx = (Math.random() - 0.5) * 2; dy = (Math.random() - 0.5) * 2; d2 = dx * dx + dy * dy; }
          const f = REP / Math.max(d2, 60);
          const d = Math.sqrt(d2);
          const ux = dx / d, uy = dy / d;
          a.vx += ux * f; a.vy += uy * f;
          b.vx -= ux * f; b.vy -= uy * f;
        }
      }
      // 弹簧
      for (const e of edges) {
        const dx = e.dst.x - e.src.x, dy = e.dst.y - e.src.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const want = e.data.kind === "builtin" ? 110 : 150;
        const f = (d - want) * SPRING;
        const ux = dx / d, uy = dy / d;
        e.src.vx += ux * f; e.src.vy += uy * f;
        e.dst.vx -= ux * f; e.dst.vy -= uy * f;
      }
      // 向心 + 积分
      for (const n of vis) {
        n.vx += (cx - n.x) * GRAV;
        n.vy += (cy - n.y) * GRAV;
        n.vx *= DAMP; n.vy *= DAMP;
        const sp = Math.sqrt(n.vx * n.vx + n.vy * n.vy);
        if (sp > 26) { n.vx *= 26 / sp; n.vy *= 26 / sp; }
        n.x += n.vx; n.y += n.vy;
      }
      // 矩形碰撞分离
      for (let iter = 0; iter < 2; iter++) {
        for (let i = 0; i < vis.length; i++) {
          for (let j = i + 1; j < vis.length; j++) {
            const a = vis[i], b = vis[j];
            const ox = (a.w + b.w) / 2 + 26 - Math.abs(a.x - b.x);
            const oy = (a.h + b.h) / 2 + 22 - Math.abs(a.y - b.y);
            if (ox > 0 && oy > 0) {
              if (ox > oy) {
                const push = oy / 2;
                const dir = a.y < b.y ? -1 : 1;
                a.y += dir * push; b.y -= dir * push;
              } else {
                const push = ox / 2;
                const dir = a.x < b.x ? -1 : 1;
                a.x += dir * push; b.x -= dir * push;
              }
            }
          }
        }
      }
    }
    requestAnimationFrame(fit);
  }

  /* ----------------------------------------------------------
   * 渲染
   * ---------------------------------------------------------- */
  function renderAll() {
    renderEdges();
    renderNodes();
    applyTransform();
    updateStats();
    if (selectedId) highlight(selectedId);
  }

  function borderPoint(n, tx, ty, gap) {
    let dx = tx - n.x, dy = ty - n.y;
    if (dx === 0 && dy === 0) { dx = 0; dy = -1; }
    const hw = n.w / 2 + (gap || 6), hh = n.h / 2 + (gap || 6);
    const s = 1 / Math.max(Math.abs(dx) / hw, Math.abs(dy) / hh);
    return [n.x + dx * s, n.y + dy * s];
  }

  function hasReverse(e) {
    return edges.some((o) => o.data.source === e.data.target && o.data.target === e.data.source);
  }

  function renderEdges() {
    gEdges.innerHTML = "";
    const showLabels = document.getElementById("chk-labels").checked;
    const bidir = new Set();
    edges.forEach((e) => { if (hasReverse(e)) bidir.add(e.data.source + "->" + e.data.target); });

    for (const e of edges) {
      const path = document.createElementNS(SVGNS, "path");
      path.setAttribute("fill", "none");
      let cls = "cg-edge" + (e.data.kind === "builtin" ? " builtin" : "");
      let marker = "url(#cg-arrow)";
      let dAttr, midX, midY;

      if (e.data.self_loop) {
        const n = e.src;
        const x0 = n.x, y0 = n.y - n.h / 2;
        dAttr = `M ${x0 - 12} ${y0} C ${x0 - 40} ${y0 - 52}, ${x0 + 40} ${y0 - 52}, ${x0 + 12} ${y0}`;
        midX = x0; midY = y0 - 44;
        cls += " self";
        marker = "url(#cg-arrow-warning)";
      } else {
        const curved = bidir.has(e.data.source + "->" + e.data.target);
        const [x1, y1] = borderPoint(e.src, e.dst.x, e.dst.y);
        const [x2, y2] = borderPoint(e.dst, e.src.x, e.src.y);
        if (curved) {
          const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
          let dx = x2 - x1, dy = y2 - y1;
          const d = Math.sqrt(dx * dx + dy * dy) || 1;
          const off = 30;
          const cxp = mx + (-dy / d) * off, cyp = my + (dx / d) * off;
          dAttr = `M ${x1} ${y1} Q ${cxp} ${cyp} ${x2} ${y2}`;
          midX = 0.25 * x1 + 0.5 * cxp + 0.25 * x2;
          midY = 0.25 * y1 + 0.5 * cyp + 0.25 * y2;
        } else {
          dAttr = `M ${x1} ${y1} L ${x2} ${y2}`;
          midX = (x1 + x2) / 2; midY = (y1 + y2) / 2;
        }
        if (e.data.kind === "builtin") marker = "url(#cg-arrow-success)";
      }
      path.setAttribute("class", cls);
      path.setAttribute("d", dAttr);
      path.setAttribute("marker-end", marker);
      gEdges.appendChild(path);
      e.el = path;

      if (showLabels && e.data.count > 1) {
        const t = document.createElementNS(SVGNS, "text");
        t.setAttribute("class", "cg-edge-label");
        t.setAttribute("x", midX);
        t.setAttribute("y", midY - 2);
        t.setAttribute("text-anchor", "middle");
        t.style.paintOrder = "stroke";
        t.style.stroke = "var(--surface)";
        t.style.strokeWidth = "4px";
        t.textContent = "×" + e.data.count;
        gEdges.appendChild(t);
        e.labelEl = t;
      }
    }
  }

  function renderNodes() {
    gNodes.innerHTML = "";
    for (const n of nodes) n.el = null;
    for (const n of nodes) {
      if (showBuiltins() === false && n.data.kind === "builtin") continue;
      const g = document.createElementNS(SVGNS, "g");
      const cls = ["cg-node", n.data.kind === "builtin" ? "builtin"
        : n.data.kind === "main" ? "main" : "user"];
      if (n.data.kind === "function" && n.data.indegree === 0) cls.push("uncalled");
      if (n.data.recursive) cls.push("recursive");
      g.setAttribute("class", cls.join(" "));
      g.setAttribute("transform", `translate(${n.x},${n.y})`);

      const rect = document.createElementNS(SVGNS, "rect");
      rect.setAttribute("x", -n.w / 2);
      rect.setAttribute("y", -n.h / 2);
      rect.setAttribute("width", n.w);
      rect.setAttribute("height", n.h);
      g.appendChild(rect);

      const t1 = document.createElementNS(SVGNS, "text");
      t1.setAttribute("class", "nm");
      t1.setAttribute("x", 0);
      t1.setAttribute("y", n.lines.length >= 2 ? -7 : 0);
      t1.setAttribute("text-anchor", "middle");
      t1.textContent = n.lines[0];
      g.appendChild(t1);
      if (n.lines[1]) {
        const t2 = document.createElementNS(SVGNS, "text");
        t2.setAttribute("class", "sub");
        t2.setAttribute("x", 0);
        t2.setAttribute("y", 10);
        t2.setAttribute("text-anchor", "middle");
        t2.style.opacity = ".75";
        t2.textContent = n.lines[1];
        g.appendChild(t2);
      }
      gNodes.appendChild(g);
      n.el = g;
      bindNodeEvents(n);
    }
  }

  function updateStats() {
    const s = graph.stats;
    document.getElementById("cg-stats").textContent =
      `${s.function_count} 个用户函数 · ${s.builtin_count} 个被调用的内置函数 · ${s.edge_count} 条调用边` +
      ` · ${s.uncalled_count} 个从未被调用 · ${s.recursive_count} 个参与递归 · ${s.unresolved_count} 处无法解析`;
  }

  /* ----------------------------------------------------------
   * 下半部分信息面板
   * ---------------------------------------------------------- */
  function renderPanels() {
    const uncalledEl = document.getElementById("cg-uncalled");
    if (!graph.uncalled.length) {
      uncalledEl.innerHTML = ML.empty("✅ 所有用户函数都被调用（或作为程序入口）");
    } else {
      uncalledEl.innerHTML = graph.uncalled.map((id) => {
        const n = nodeMap.get(id);
        const d = n.data;
        return `<div class="sym" style="cursor:pointer" data-focus="${esc(id)}">
          <span class="name">${esc(d.label)}(${esc(d.params.join(", "))})</span>
          <span class="badge red">未被调用</span>
          <span class="loc" style="margin-left:auto">L${d.line} · 出度 ${d.outdegree}</span>
        </div>`;
      }).join("");
      uncalledEl.querySelectorAll("[data-focus]").forEach((el) => {
        el.onclick = () => focusNode(el.getAttribute("data-focus"));
      });
    }

    const notesEl = document.getElementById("cg-notes");
    let html = "";
    for (const g0 of graph.recursive_groups) {
      const isSelf = g0.kind === "self";
      html += `<div class="diag ${isSelf ? "warning" : "info"}" style="border-left-width:4px">
        <div class="head">${ML.badge(isSelf ? "直接递归（自环）" : "间接递归", isSelf ? "amber" : "blue")}</div>
        <div class="msg mono" style="font-size:12.5px">${esc(g0.members.join(isSelf ? "" : " ↔ "))}</div>
      </div>`;
    }
    if (graph.unresolved.length) {
      html += `<table class="tbl"><thead><tr><th>调用所在</th><th>调用</th><th>说明</th><th>位置</th></tr></thead><tbody>`;
      for (const u of graph.unresolved) {
        const name = u.kind === "indirect" ? "(表达式)" : `<span class="mono">${esc(u.name)}(…)</span>`;
        html += `<tr><td class="mono">${esc(u.caller === "<main>" ? "<main>" : u.caller)}</td>
          <td>${name}</td><td>${esc(UNRESOLVED_TEXT[u.kind] || u.kind)}</td>
          <td class="mono muted">L${u.line}:C${u.column}</td></tr>`;
      }
      html += "</tbody></table>";
    }
    if (!html) html = ML.empty("✅ 无递归环，所有调用均已静态解析");
    notesEl.innerHTML = html;
  }

  /* ----------------------------------------------------------
   * 交互：悬停高亮 / 点击详情 / 拖拽 / 平移缩放
   * ---------------------------------------------------------- */
  function connected(id) {
    const set = new Set([id]);
    const rel = new Set();
    for (const e of edges) {
      if (e.data.source === id) { set.add(e.data.target); rel.add(e.data.source + "->" + e.data.target); }
      if (e.data.target === id) { set.add(e.data.source); rel.add(e.data.source + "->" + e.data.target); }
    }
    return { nodes: set, edges: rel };
  }

  function highlight(id) {
    if (!id) {
      edges.forEach((e) => { e.el.removeAttribute("class"); e.el.setAttribute("class",
        "cg-edge" + (e.data.kind === "builtin" ? " builtin" : "") + (e.data.self_loop ? " self" : "")); });
      nodes.forEach((n) => { if (n.el) n.el.classList.remove("hl", "dim"); });
      return;
    }
    const c = connected(id);
    nodes.forEach((n) => {
      if (!n.el) return;
      n.el.classList.toggle("dim", !c.nodes.has(n.id));
      n.el.classList.toggle("hl", n.id === id);
    });
    edges.forEach((e) => {
      const key = e.data.source + "->" + e.data.target;
      const on = c.edges.has(key);
      e.el.classList.toggle("dim", !on);
      e.el.classList.toggle("hl", on);
      if (e.labelEl) e.labelEl.style.opacity = on ? "1" : ".15";
    });
  }

  function focusNode(id) {
    selectedId = id;
    showDetail(id);
    highlight(id);
    const n = nodeMap.get(id);
    if (!n) return;
    const k = transform.k;
    transform.x = wrap.clientWidth / 2 - n.x * k;
    transform.y = wrap.clientHeight / 2 - n.y * k;
    applyTransform();
  }

  function showDetail(id) {
    const n = nodeMap.get(id);
    const d = n.data;
    const panel = document.getElementById("cg-detail");
    const kindBadge = d.kind === "builtin" ? ML.badge("内置函数", "green")
      : d.kind === "main" ? ML.badge("程序入口", "gray")
      : d.indegree === 0 ? ML.badge("从未被调用", "red")
      : ML.badge("用户函数", "purple");
    let html = `<div class="t">${esc(d.label)}${d.kind === "function" ? "(" + esc(d.params.join(", ")) + ")" : ""}</div>
      <div class="row">${kindBadge}${d.recursive ? ML.badge("递归", "amber") : ""}
        ${d.kind === "function" ? `<span class="badge cyan">L${d.line}:C${d.column}</span>` : ""}</div>
      <div class="row">入度 ${d.indegree} · 出度 ${d.outdegree}</div>`;

    const siteRows = (title, list, outgoing) => {
      if (!list.length) return "";
      let h = `<div class="row" style="margin-top:8px;font-weight:600;color:var(--text)">${title}</div><div class="sites">`;
      for (const it of list) {
        const loc = `L${it.site.line}:C${it.site.column}`;
        const note = it.site.synthetic ? "（print 语句隐式调用）" : "";
        h += `<div class="st">${outgoing ? "→" : "←"} ${esc(it.other)} <span style="float:right">${loc}${note}</span></div>`;
      }
      return h + "</div>";
    };

    const outs = [], ins = [];
    for (const e of edges) {
      if (e.data.source === id) {
        for (const st of e.data.sites) outs.push({ other: e.data.target, site: st });
      }
      if (e.data.target === id) {
        for (const st of e.data.sites) ins.push({ other: e.data.source, site: st });
      }
    }
    html += siteRows("调用（出边 " + d.outdegree + "）", outs, true);
    html += siteRows("被调用（入边 " + d.indegree + "）", ins, false);
    panel.innerHTML = html;
    panel.classList.add("open");
  }

  function bindNodeEvents(n) {
    let dragging = false, moved = false;
    let startX, startY, origX, origY;

    n.el.addEventListener("mouseenter", () => { if (!selectedId) highlight(n.id); });
    n.el.addEventListener("mouseleave", () => { if (!selectedId) highlight(null); });

    n.el.addEventListener("mousedown", (ev) => {
      ev.stopPropagation();
      dragging = true; moved = false;
      startX = ev.clientX; startY = ev.clientY;
      origX = n.x; origY = n.y;
      n.el.classList.add("dragging");
    });
    window.addEventListener("mousemove", (ev) => {
      if (!dragging) return;
      const dx = (ev.clientX - startX) / transform.k;
      const dy = (ev.clientY - startY) / transform.k;
      if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) > 4) moved = true;
      n.x = origX + dx; n.y = origY + dy;
      n.el.setAttribute("transform", `translate(${n.x},${n.y})`);
      renderEdges();
      if (selectedId) highlight(selectedId);
    });
    window.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      n.el.classList.remove("dragging");
      if (!moved) {
        selectedId = selectedId === n.id ? null : n.id;
        if (selectedId) showDetail(n.id);
        else document.getElementById("cg-detail").classList.remove("open");
        highlight(selectedId);
      }
    });
  }

  // 空白处：拖拽平移 / 点击取消选中
  let panning = false, panStart = null;
  svg.addEventListener("mousedown", (ev) => {
    if (ev.target.closest(".cg-node") || ev.target.closest(".cg-toolbar")) return;
    panning = true;
    panStart = { x: ev.clientX, y: ev.clientY, tx: transform.x, ty: transform.y };
    wrap.classList.add("grabbing");
  });
  window.addEventListener("mousemove", (ev) => {
    if (!panning) return;
    transform.x = panStart.tx + (ev.clientX - panStart.x);
    transform.y = panStart.ty + (ev.clientY - panStart.y);
    applyTransform();
  });
  window.addEventListener("mouseup", (ev) => {
    if (panning && Math.abs(ev.clientX - panStart.x) + Math.abs(ev.clientY - panStart.y) < 4) {
      selectedId = null;
      document.getElementById("cg-detail").classList.remove("open");
      highlight(null);
    }
    panning = false;
    wrap.classList.remove("grabbing");
  });

  // 滚轮缩放（以光标为锚点）
  wrap.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    const rect = svg.getBoundingClientRect();
    const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
    const factor = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
    zoomAt(factor, mx, my);
  }, { passive: false });

  function zoomAt(factor, mx, my) {
    const rect = svg.getBoundingClientRect();
    if (mx == null) { mx = rect.width / 2; my = rect.height / 2; }
    const k0 = transform.k;
    const k1 = Math.min(3, Math.max(0.2, k0 * factor));
    // 保持光标下的世界坐标不动
    transform.x = mx - (mx - transform.x) * (k1 / k0);
    transform.y = my - (my - transform.y) * (k1 / k0);
    transform.k = k1;
    applyTransform();
  }

  function fit() {
    const vis = visibleNodes();
    if (!vis.length) { transform = { x: 0, y: 0, k: 1 }; applyTransform(); return; }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of vis) {
      minX = Math.min(minX, n.x - n.w / 2 - 60);
      maxX = Math.max(maxX, n.x + n.w / 2 + 60);
      minY = Math.min(minY, n.y - n.h / 2 - 60);
      maxY = Math.max(maxY, n.y + n.h / 2 + 60);
    }
    const W = wrap.clientWidth, H = wrap.clientHeight;
    const k = Math.min(W / (maxX - minX), H / (maxY - minY), 1.6);
    transform.k = k;
    transform.x = W / 2 - ((minX + maxX) / 2) * k;
    transform.y = H / 2 - ((minY + maxY) / 2) * k;
    applyTransform();
  }

  function applyTransform() {
    viewport.setAttribute("transform",
      `translate(${transform.x},${transform.y}) scale(${transform.k})`);
  }
})();
