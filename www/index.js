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
    this.states = new Map();
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
    localStorage.setItem('ros_graph_state', JSON.stringify(Array.from(this.states.entries())));
  }

  loadState() {
    const saved = localStorage.getItem('ros_graph_cache');
    if (saved) {
      this.states = new Map(JSON.parse(saved));
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

  getData() {
    return {
      nodes: this.data.nodes.map(elem => ({...elem, state: this.states.get(elem.id)})),
      edges: this.data.edges.map(elem => ({...elem, state: this.states.get(elem.id)})),
    };
  }
}

class HoldState {
  constructor(render, config) {
    this.target = "";
    this.locked = false;
    this.timer = 0;
    this.holdPos = {x: Infinity, y: Infinity};
    this.prevPos = {x: Infinity, y: Infinity};
    this.render = render;

    this.config = {
      holdTimeout: config.holdTimeout,
      dragRebounce: config.dragRebounce,
    };
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
  constructor(containerId, apiUrl) {
    this.config = {
      holdTimeout: 400, // ms
      dragRebounce: 5, // pixel
      unlockDelay: 100, // ms
    };

    this.elements = [];
    this.container = document.getElementById(containerId);
    this.apiUrl = apiUrl;
    this.manager = new RosGraphManager();
    this.cy = undefined;
    this.holdState = new HoldState(() => this.render(), this.config);
  }

  async init() {
    await this.manager.refresh(this.apiUrl);
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
        data: { ...node, label: node.name },
        position: node.state?.position ?? undefined,
        locked: node.state?.locked ?? false,
        classes: [
          (node.state?.hidden ?? false) ? 'hidden' : '',
          this.holdState.target == node.id ?
            (this.holdState.locked ? 'locked' : '')
          :
            ((node.state?.locked ?? false) ? 'locked' : ''),
          is_new ? 'new-added' : '',
        ].join(" ")
      });
    });

    // Add Edges from Manager
    data.edges.forEach((edge) => {
      const is_new = this.cy?.getElementById(edge.id)?.empty() ?? true;
      elements.push({
        group: 'edges',
        data: { ...edge, label: edge.topic },
        classes: [
          (edge.state?.hidden ?? false) ? 'hidden' : '',
          is_new ? 'new-added' : '',
        ].join(" ")
      });
    });

    if (!this.cy) {
      this.cy = cytoscape({
        container: this.container,
        elements: elements,
        style: [
          { selector: 'node', style: { 'label': 'data(label)', 'background-color': '#0074D9' } },
          { selector: 'node.locked', style: { 'border-width': 2 } },
          { selector: '.hidden', style: { 'display': 'none' } },
          { selector: 'edge', style: { 'label': 'data(label)', 'curve-style': 'bezier', 'target-arrow-shape': 'triangle' } },
          // { selector: 'node.new-added', style: { 'border-width': 2, 'border-color': '#2ECC40', 'border-style': 'dashed' } },
        ],
      });
      this.resetPhysics();
    } else {
      this.cy.json({ elements: elements });
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
        }, this.config.unlockDelay);
      }
    });

    // HIDE: Double click
    this.cy.on('dblclick', (e) => {
      if (e.target !== this.cy) {
        const id = e.target.id();
        const state = this.manager.getState(id);
        state.hidden = true;
        this.render();

      } else {
        for (const state of this.manager.states.values())
          state.hidden = false;
        this.render();
      }
    });

    window.addEventListener("keypress", async (event) => {
      if (event.key === "r") {
        await this.manager.refresh(this.apiUrl);
        this.render();
        this.resetPhysics();
      }
    })
  }

  // // Helper to sync specific node visual state without full re-render
  // syncNodeState(id) {
  //   const data = this.manager.nodes.get(id);
  //   const cyNode = this.cy.getElementById(id);
  //   data.locked ? cyNode.lock() : cyNode.unlock();
  // }
}

const viz = new RosVisualizer('cy', '/api/graph');
viz.init();