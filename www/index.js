import cytoscape from 'https://esm.sh/cytoscape';
import cola from 'https://esm.sh/cytoscape-cola';

cytoscape.use(cola);

class RosGraphManager {
  constructor() {
    // [node_id]: {
    //   position?: {x: number, y: number},
    //   locked?: boolean,
    //   hidden?: boolean,
    // }
    // [edge_id]: {
    //   hidden?: boolean,
    // }
    // "canvas": {
    //   viewport?: {zoom: number, pan: {x: number, y: number}},
    //   runPhysics?: boolean,
    // }
    this.states = new Map();

    this.config = {
      holdTimeout: 400, // ms
      dragRebounce: 5, // pixel
      unlockDelay: 100, // ms
    };

    // {
    //   nodes: {id: string, name: string, type: string}[],
    //   edges: {id: string, source: string, target: string, topic: string, type: string}[],
    // }
    this.data = [];
  }

  static nodeID(node_name) { return `node-${node_name}`; }
  static edgeID(topic_name, pub_node_name, sub_node_name) { return `edge-${topic_name}-${pub_node_name}-${sub_node_name}`; }

  getState(id) {
    let state = this.states.get(id);
    if (state == undefined) {
      this.states.set(id, {});
      state = this.states.get(id);
    }
    return state;
  }
  
  saveState() {
    const states_json = JSON.stringify(Array.from(this.states.entries()));
    const config_json = JSON.stringify(this.config);
    localStorage.setItem('ros_graph_states', states_json);
    localStorage.setItem('ros_graph_config', config_json);
  }

  loadState() {
    const states_json = localStorage.getItem('ros_graph_states');
    const config_json = localStorage.getItem('ros_graph_config');
    if (states_json) {
      this.states = new Map(JSON.parse(states_json));
    }
    if (config_json) {
      this.config = JSON.parse(config_json);
    }
  }

  async refresh(apiUrl) {
    const response = await fetch(apiUrl);
    const raw = await response.json();
    this.data = this.process(raw);
    return this.data;
  }

  process(raw) {
    if (!raw) return [];
    const nodes = [];
    const edges = [];

    // 1. Create Map of Topics -> Subscribers for quick lookup
    const topicSubscribers = {};
    raw.subscribers.forEach(sub => {
      topicSubscribers[sub.topic] = sub.nodes;
    });

    // 2. Add Nodes
    raw.node_types.forEach(n => {
      const id = RosGraphManager.nodeID(n.node);
      nodes.push({
        id: id,
        name: n.node,
        type: n.type,
      });
    });

    // 3. Add Edges (Publisher -> Topic -> Subscriber)
    raw.publishers.forEach(pub => {
      const subs = topicSubscribers[pub.topic] ?? [];
      const topicType = raw.topic_types.find(t => t.topic === pub.topic)?.type ?? 'unknown';

      subs.forEach(subNode => {
        pub.nodes.forEach(pubNode => {
          const pub_id = RosGraphManager.nodeID(pubNode);
          const sub_id = RosGraphManager.nodeID(subNode);
          const id = RosGraphManager.edgeID(pub.topic, pubNode, subNode);
          edges.push({
            id: id,
            source: pub_id,
            target: sub_id,
            topic: pub.topic,
            type: topicType,
          });
        });
      });
    });

    return {nodes, edges};
  }

  // {
  //   nodes: {id: string, name: string, type: string, ...state}[],
  //   edges: {id: string, source: string, target: string, topic: string, type: string, ...state}[],
  // }
  getData() {
    return {
      nodes: this.data.nodes.map(elem => ({...elem, ...this.states.get(elem.id)})),
      edges: this.data.edges.map(elem => ({...elem, ...this.states.get(elem.id)})),
    };
  }
}

class HoldState {
  constructor(render, config) {
    this.config = config;

    this.target = "";
    this.locked = false;
    this.timer = 0;
    this.holdPos = {x: Infinity, y: Infinity};
    this.prevPos = {x: Infinity, y: Infinity};
    this.render = render;
  }
  
  grab(pos, id, locked) {
    // console.log("grab", id);
    this.target = id;
    this.locked = locked;
    this.holdPos.x = pos.x;
    this.holdPos.y = pos.y;
    this.prevPos.x = pos.x;
    this.prevPos.y = pos.y;
    this._hold();
  }

  drag(pos) {
    if (this.target === "") return false;
    const dis = {
      x: pos.x - this.prevPos.x,
      y: pos.y - this.prevPos.y,
    };
    this.prevPos.x = pos.x;
    this.prevPos.y = pos.y;
    if (Math.max(Math.abs(this.holdPos.x - pos.x), Math.abs(this.holdPos.y - pos.y)) <= this.config.dragRebounce) return dis;

    const changed = this.locked !== false;
    this.locked = false;
    if (changed) {
      this.render();
      // console.log("unlock", this.target);
    }

    this.holdPos.x = pos.x;
    this.holdPos.y = pos.y;
    this._hold();
    return dis;
  }
  
  _hold() {
    if (this.timer !== 0) {
      clearTimeout(this.timer);
      this.timer = 0;
    }
    this.timer = setTimeout(() => {
      this.timer = 0;

      const changed = this.locked !== true;
      this.locked = true;
      if (changed) {
        this.render();
        // console.log("lock", this.target);
      }
    }, this.config.holdTimeout);
  }

  free() {
    if (this.target === "") return false;

    // console.log("free", this.target);
    this.holdPos.x = Infinity;
    this.holdPos.y = Infinity;
    this.prevPos.x = Infinity;
    this.prevPos.y = Infinity;
    this.target = "";
    if (this.timer !== 0) {
      clearTimeout(this.timer);
      this.timer = 0;
    }
    const locked = this.locked;
    this.locked = false;
    return locked;
  }
}

class RosVisualizer {
  constructor(containerId, apiURL) {
    this.elements = [];
    this.container = document.getElementById(containerId);
    this.apiURL = apiURL;
    this.manager = new RosGraphManager();
    this.manager.loadState();

    this.cy = undefined;
    this.layout = undefined;
    this.holdState = new HoldState(() => this.render(), this.manager.config);
    this.activePanels = new Map();
  }

  async init() {
    await this.manager.refresh(`${this.apiURL}/graph`);
    this.render();
    this.setupEvents();
  }

  render() {
    const data = this.manager.getData();

    const elements = [];

    // Add Nodes from Manager
    data.nodes.forEach((node) => {
      const is_new = this.cy?.getElementById(node.id)?.empty() ?? true;
      elements.push({
        group: 'nodes',
        data: {...node},
        locked: node?.locked ?? false,
        classes: [
          (node?.hidden ?? false) ? 'hidden' : '',
          this.holdState.target == node.id ?
            (this.holdState.locked ? 'locked' : '')
          :
            ((node?.locked ?? false) ? 'locked' : ''),
          is_new ? 'new-added' : '',
        ].join(" ")
      });
    });

    // Add Edges from Manager
    data.edges.forEach((edge) => {
      const is_new = this.cy?.getElementById(edge.id)?.empty() ?? true;
      elements.push({
        group: 'edges',
        data: {...edge},
        classes: [
          (edge?.hidden ?? false) ? 'hidden' : '',
          is_new ? 'new-added' : '',
        ].join(" ")
      });
    });

    if (!this.cy) {
      this.cy = cytoscape({
        container: this.container,
        elements: elements,
        style: [
          { selector: 'node', style: { 'label': 'data(name)', 'background-color': '#005cac', 'color': '#cccccc' } },
          { selector: 'node:selected', style: { 'outline-width': 2, 'outline-color': '#656565' } },
          { selector: 'node.locked', style: { 'border-width': 2, 'border-color': '#3491b3' } },
          { selector: '.hidden', style: { 'display': 'none' } },
          { selector: 'edge', style: { 'label': 'data(topic)', 'curve-style': 'bezier', 'target-arrow-shape': 'triangle', 'line-color': '#043b6c', 'color': '#cccccc' } },
        ],
      });

      this.cy.batch(() => {
        data.nodes.forEach((node) => {
          if (node?.position === undefined) return;
          const elem = this.cy.getElementById(node.id);
          if (elem.locked()) {
            elem.unlock();
            elem.position(node.position);
            elem.lock();
          } else {
            elem.position(node.position);
          }
        });
        const canvas = this.manager.getState("canvas");
        if (canvas.viewport)
          this.cy.viewport({...canvas.viewport});
      });
      
      this.resetPhysics();
    } else {
      this.cy.json({ elements: elements });

      data.nodes.forEach((node) => {
        if (node?.position === undefined) return;
        const elem = this.cy.getElementById(node.id);
        if (elem.hasClass("new-added"))
          elem.position(node.position);
      });
    }
  }

  resetPhysics() {
    const options = {
      name: 'cola',
      infinite: true,      // Keep simulation running forever
      fit: false,          // Don't auto-zoom while user is interacting
      edgeLength: 100,     // The "natural" spring length
      nodeSpacing: 50,     // Minimum distance between nodes
      unconstrIter: 10,    // Initial unconstrained iterations
      userConstIter: 20,   // Iterations to respond to user interaction
      allConstIter: 20,    // Final iterations
      animate: true,
      randomize: false,    // Important: don't scramble positions on refresh
    };

    // If a layout is already running, stop it before starting a new one
    if (this.layout) this.layout.stop();

    // settle down new elements first
    {
      // 1. Select only the new nodes and their connected edges
      const newElements = this.cy.elements('.new-added, edge[source = "new-added"], edge[target = "new-added"]');
      if (newElements.length > 0) {
        // 2. Run layout ONLY on the new elements
        const newElemLayout = newElements.layout({
          ...options,
          infinite: false,
          continuous: false,
        });

        newElemLayout.run();
        newElemLayout.stop();
        // 3. Once the layout finishes, remove the 'new-added' flag in the Manager
        // so they don't jump again on the next fetch.
        newElements.forEach(elem => elem.removeClass('new-added'));
      }
    }

    this.layout = this.cy.makeLayout(options);

    if (this.manager.getState("canvas")?.runPhysics ?? true)
      this.layout.run();
  }

  setupEvents() {
    this.cy.on('grab', 'node', (e) => {
      const id = e.target.id();
      const state = this.manager.getState(id);
      this.holdState.grab(e.position, id, state?.locked ?? false);
    });

    this.cy.on('drag', 'node', (e) => {
      this.holdState.drag(e.position);
    });

    this.cy.on('free', 'node', (e) => {
      const locked = this.holdState.free();
      const id = e.target.id();
      const state = this.manager.getState(id);
      state.locked = locked;
      this.render();
    });

    let draggingLocked = false;

    this.cy.on('mousedown', 'node', (e) => {
      const id = e.target.id();
      const state = this.manager.getState(id);
      if (!state.locked) return;

      draggingLocked = true;
      this.holdState.grab(e.position, id, state?.locked ?? false);
    });

    this.cy.on('mousemove', (e) => {
      if (!draggingLocked) return;

      const dis = this.holdState.drag(e.position);
      const target = this.cy.getElementById(this.holdState.target);
      target.unlock();
      target.shift(dis);
      target.lock();
      this.render();
    });

    this.cy.on('mouseup', (e) => {
      if (!draggingLocked) return;
      draggingLocked = false;
      const id = this.holdState.target;
      const locked = this.holdState.free();

      if (!locked) {
        setTimeout(() => {
          const state = this.manager.getState(id);
          state.locked = false;
          this.render();
        }, this.manager.config.unlockDelay);
      }
    });

    // this.cy.on('dblclick', (e) => {
    //   if (e.target !== this.cy) {
    //     const id = e.target.id();
    //     const state = this.manager.getState(id);
    //     state.hidden = true;
    //     this.render();
    //   
    //   } else {
    //     for (const state of this.manager.states.values())
    //       state.hidden = false;
    //     this.render();
    //   }
    // });

    this.cy.on('dblclick', 'edge', async (e) => {
      const topic = e.target.data('topic');
      this.createFloatingPanel(topic);
    });

    window.addEventListener("keypress", async (event) => {
      if (event.key === "r") {
        await this.manager.refresh(`${this.apiURL}/graph`);
        this.render();
        this.resetPhysics();
      }
      if (event.key === "d") {
        this.cy.elements(":selected").forEach((e) => {
          const state = this.manager.getState(e.id());
          state.hidden = true;
        });
        this.render();
      }
      if (event.key === "D") {
        for (const state of this.manager.states.values())
          state.hidden = false;
        this.render();
      }
      if (event.key === " ") {
        const canvas = this.manager.getState("canvas");
        if (canvas?.runPhysics ?? true) {
          canvas.runPhysics = false;
          this.layout?.stop();
        } else {
          canvas.runPhysics = true;
          this.layout?.run();
        }
      }
    });
    
    window.addEventListener("unload", () => {
      this.syncStates();
      this.manager.saveState();
      this.render();
    });
  }

  syncStates() {
    this.cy.nodes().forEach((node) => {
      const pos = node.position();
      const data = this.manager.getState(node.id());
      data.position = {x: pos.x, y: pos.y};
    });

    const zoom = this.cy.zoom();
    const pan = this.cy.pan();
    const canvas = this.manager.getState("canvas");
    canvas.viewport = {zoom, pan: {x: pan.x, y: pan.y}};
  }

  createFloatingPanel(topic) {
    if (this.activePanels.has(topic)) return;

    const panel = document.createElement('div');
    panel.className = 'floating-panel';
    // Note: Add 'user-select: none' to the header to prevent text highlighting while dragging
    panel.style.cssText = `
      position: absolute; left: 150px; top: 150px;
      width: 280px; background: white; border: 1px solid #444;
      box-shadow: 4px 4px 15px rgba(0,0,0,0.3); z-index: 1000;
      pointer-events: auto; border-radius: 4px; font-family: monospace;
      resize: both; overflow: hidden;
      display: flex; flex-direction: column;
    `;

    panel.innerHTML = `
      <div class="panel-header" style="cursor:move; background:#333; color:white; padding:5px 10px; display:flex; justify-content:space-between; align-items:center;">
        <div>
          <span class="title" style="font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 180px;"></span>
          <span class="freq" style="color:#01FF70; margin-left:10px;"></span>
        </div>
        <div style="height:1.2em;">
          <button class="play-btn" title="Pause/Play" style="background:none; border:none; color:white; cursor:pointer; padding: 0 5px;">⏸</button>
          <button class="close-btn" title="Close" style="background:none; border:none; color:white; cursor:pointer; padding: 0 5px;">✖</button>
        </div>
      </div>
      <pre class="panel-content"
        style="flex:1; margin:0; background:#1e1e1e; color:#dcdcdc; padding:8px; font-size:11px; overflow-y:auto;"
      >Loading topic info...</pre>
    `;

    document.getElementById('panel-container').appendChild(panel);
    this.activePanels.set(topic, panel);

    panel.querySelector('.title').innerText = topic;

    // Setup Button Events
    panel.querySelector('.close-btn').onclick = () => {
      if (panel.eventSource) panel.eventSource.close();
      panel.remove();
      this.activePanels.delete(topic);
    };

    panel.querySelector('.play-btn').onclick = () => {
      if (panel.eventSource) {
        panel.eventSource.close();
        panel.eventSource = undefined;
        panel.querySelector('.play-btn').innerText = "▶";
      } else {
        panel.eventSource = this.initPanelDataStream(topic, panel);
        panel.querySelector('.play-btn').innerText = "⏸";
      }
    };

    this.makeElementDraggable(panel);
    
    panel.eventSource = this.initPanelDataStream(topic, panel);
  }

  initPanelDataStream(topic, panel) {
    const contentArea = panel.querySelector('.panel-content');
    const freqLabel = panel.querySelector('.panel-header .freq');

    const source = new EventSource(`${this.apiURL}/topic_info${topic}`);

    source.onmessage = (event) => {
      const data = JSON.parse(event.data);
      
      if (data.error) {
        contentArea.innerHTML = `<span style="color:red;">${data.error}</span>`;
      } else {
        // Update the Header with the frequency
        freqLabel.innerText = `${data.frequency} Hz`;

        // Render the content (JSON.stringify with null, 2 makes it pretty)
        contentArea.innerText = JSON.stringify(data.message, null, 2);
      }
    };
    
    return source;
  }

  makeElementDraggable(el) {
    const header = el.querySelector('.panel-header');
    let dx = 0, dy = 0, x = 0, y = 0;

    header.onmousedown = (e) => {
      e.preventDefault();
      x = e.clientX;
      y = e.clientY;
      document.onmouseup = () => {
        document.onmouseup = null;
        document.onmousemove = null;
      };
      document.onmousemove = (e) => {
        e.preventDefault();
        dx = e.clientX - x;
        dy = e.clientY - y;
        x = e.clientX;
        y = e.clientY;
        el.style.top = (el.offsetTop + dy) + "px";
        el.style.left = (el.offsetLeft + dx) + "px";
      };
    };
  }
}

const viz = new RosVisualizer('cy', '/api');
viz.init();