function removeElem(arr, elem) {
    if (arr.includes(elem)) arr.splice(arr.indexOf(elem), 1);
}

let network, options, nodesDS, edgesDS, displayNodesDS, displayEdgesDS;

nodesDS = new vis.DataSet();
edgesDS = new vis.DataSet();
displayNodesDS = new vis.DataSet();
displayEdgesDS = new vis.DataSet();

options = {
    layout: { randomSeed: 2 },
    physics: {
        enabled: true,
        stabilization: { iterations: 150 },
        barnesHut: { gravitationalConstant: -2000 }
    },
    interaction: {
        multiselect: true,
        zoomSpeed: 0.1,
    },
};

// {
//    nodes: {id: string, name: string, show: boolean, level: number}[],
//    edges: {id: string, topic: string, from: string, to: string, show: boolean}[],
// }
function processRosGraph(rawData) {
    const nodes = new Map(); // Use Map to avoid duplicates
    const edges = [];

    const topicMap = new Map();

    for (const [topic, pubNodes] of rawData.publishers) {
        if (!topicMap.has(topic)) topicMap.set(topic, { pubs: [], subs: [] });
        topicMap.get(topic).pubs.push(...pubNodes);
        for (const name of pubNodes)
            if (!nodes.has(name))
                nodes.set(name, {id: `[${name}]`, name, type: rawData.node_metadata[name], show: false, level: 0});
    }

    for (const [topic, subNodes] of rawData.subscribers) {
        if (!topicMap.has(topic)) topicMap.set(topic, { pubs: [], subs: [] });
        topicMap.get(topic).subs.push(...subNodes);
        for (const name of subNodes)
            if (!nodes.has(name))
                nodes.set(name, {id: `[${name}]`, name, type: rawData.node_metadata[name], show: false, level: 0});
    }

    for (const [topic, { pubs, subs }] of topicMap.entries())
        for (const from_name of pubs)
            for (const to_name of subs)
                edges.push({
                    id: `[${from_name}]>-(${topic})->[${to_name}]`,
                    topic,
                    type: rawData.topic_metadata[topic],
                    from: `[${from_name}]`,
                    to: `[${to_name}]`,
                    show: false
                });

    return {
        nodes: Array.from(nodes.values()),
        edges: edges
    };
}

function updateSession(func) {
    network.setOptions({physics:{enabled:false}, interaction:{dragView:false, zoomView:false, dragNodes:false}});
    network.storePositions();
    const tofixed = displayNodesDS.get().filter(node => !(node.fixed ?? false)).map(({id}) => id);
    displayNodesDS.update(tofixed.map(id => ({id, fixed: true, physics: false})));
    const position = network.getViewPosition();
    const scale = network.getScale();

    function recover() {
        network.moveTo({ position, scale });
        displayNodesDS.update(tofixed.filter(id => displayNodesDS.get(id)).map(id => ({id, fixed: false, physics: true})));
        const enabled = options?.physics?.enabled ?? true;
        const dragView = options?.interaction?.dragView ?? true;
        const zoomView = options?.interaction?.zoomView ?? true;
        const dragNodes = options?.interaction?.dragNodes ?? true;
        network.setOptions({physics:{enabled}, interaction:{dragView, zoomView, dragNodes}});
    }

    let updated = false;

    try {

        updated = func();

    } finally {
        if (updated) {
            network.once("stabilizationIterationsDone", recover);
            network.stabilize();
        } else {
            recover();
        }
    }
}

function getDepth(path) {
    return path.split('/').filter(p => p !== "").length + 1;
}

function getAncestor(path, level = 1) {
    if (level <= 0) return path;
    let parts = path.split('/').filter(p => p !== "");
    parts = parts.slice(0, -level);
    if (parts.length === 0) return "/";
    return "/" + parts.join('/') + "/";
}

function isAncestor(path1, path2) {
    return path1.length <= path2.length && path1 === path2.substring(0, path1.length);
}

function showNode(id) {
    const node = nodesDS.get(id);
    if (!node) return;
    if (node.show) return;
    node.show = true;
    nodesDS.update(node);

    _showNode(node);

    const edges = edgesDS.get({filter: edge => edge.show && (edge.from === id || edge.to === id)});
    for (const edge of edges)
        _showEdge(edge);
}

function _showNode(node, pos = {}) {
    const name_ = getAncestor(node.name, node.level);
    const id_ = `[${name_}]`;
    const displayNode = displayNodesDS.get(id_);
    if (displayNode) {
        displayNode.node_sources.push(node.id);
        if (displayNode.node_sources.length === 1) {
            displayNode.title = nodesDS.get(displayNode.node_sources).map(node => node.type).join(", ");
        } else {
            displayNode.title = nodesDS.get(displayNode.node_sources).map(node => node.name).join(", ");
        }
        displayNodesDS.update(displayNode);
    } else {
        displayNodesDS.add({
            ...pos,
            id: id_,
            label: name_,
            title: node.type,
            shape: 'box',
            isGroup: node.level > 0,
            node_sources: [node.id],
        });
    }
}

function showEdge(id) {
    const edge = edgesDS.get(id);
    if (!edge) return;
    if (edge.show) return;
    edge.show = true;
    edgesDS.update(edge);

    if (!nodesDS.get(edge.from).show || !nodesDS.get(edge.to).show) return;
    
    _showEdge(edge);
}

function _showEdge(edge) {
    const from = nodesDS.get(edge.from);
    const to = nodesDS.get(edge.to);
    const from_ = getAncestor(from.name, from.level);
    const to_ = getAncestor(to.name, to.level);
    const from_id_ = `[${from_}]`;
    const to_id_ = `[${to_}]`;
    const id_ = `[${from.name}]>-(${edge.topic})->[${to.name}]`;

    displayEdgesDS.add({
        id: id_,
        from: from_id_,
        to: to_id_,
        label: edge.topic,
        title: edge.type,
        arrows: 'to',
        font: { size: 10 },
        node_source: edge.id,
    });
}

function hideNode(id) {
    const node = nodesDS.get(id);
    if (!node) return;
    if (!node.show) return;
    node.show = false;
    nodesDS.update(node);

    const edges = edgesDS.get({filter: edge => edge.show && (edge.from === id || edge.to === id)});
    for (const edge of edges)
        _hideEdge(edge);

    _hideNode(node);
}

function _hideNode(node) {
    const name_ = getAncestor(node.name, node.level);
    const id_ = `[${name_}]`;
    const displayNode = displayNodesDS.get(id_);
    if (displayNode.node_sources.length === 1 && displayNode.node_sources.includes(node.id)) {
        displayNodesDS.remove(id_);
    } else {
        console.log(displayNode);
        removeElem(displayNode.node_sources, node.id);
        if (displayNode.node_sources.length === 1) {
            displayNode.title = nodesDS.get(displayNode.node_sources).map(node => node.type).join(", ");
        } else {
            displayNode.title = nodesDS.get(displayNode.node_sources).map(node => node.name).join(", ");
        }
        displayNodesDS.update(displayNode);
    }
}

function hideEdge(id) {
    const edge = edgesDS.get(id);
    if (!edge) return;
    if (!edge.show) return;
    edge.show = false;
    edgesDS.update(edge);
    
    _hideEdge(edge);
}

function _hideEdge(edge) {
    const from = nodesDS.get(edge.from);
    const to = nodesDS.get(edge.to);
    const id_ = `[${from.name}]>-(${edge.topic})->[${to.name}]`;

    displayEdgesDS.remove(id_);
}

function adjustNodeLevel(id, incr) {
    const node = nodesDS.get(id);
    if (!node) return;
    const depth = getDepth(node.name);
    const new_level = Math.min(Math.max(0, node.level + incr), depth - 1);
    if (node.level === new_level) return;

    const name_ = getAncestor(node.name, node.level);
    const id_ = `[${name_}]`;
    const displayNode = displayNodesDS.get(id_);
    
    node.level = new_level;
    nodesDS.update(node);

    if (displayNode.node_sources.length === 1 && displayNode.node_sources.includes(node.id)) {
        const pos = network.getPositions([displayNode.id])[displayNode.id];
        displayNodesDS.remove(displayNode.id);
        _showNode(node, pos);
    } else {
        const pos = network.getPositions([displayNode.id])[displayNode.id];
        removeElem(displayNode.node_sources, node.id);
        if (displayNode.node_sources.length === 1) {
            displayNode.title = nodesDS.get(displayNode.node_sources).map(node => node.type).join(", ");
        } else {
            displayNode.title = nodesDS.get(displayNode.node_sources).map(node => node.name).join(", ");
        }
        displayNodesDS.update(displayNode);
        _showNode(node, pos);
    }

    const edges = edgesDS.get({filter: edge => edge.show && (edge.from === id || edge.to === id)});
    for (const edge of edges) {
        const from = nodesDS.get(edge.from);
        const to = nodesDS.get(edge.to);
        const from_ = getAncestor(from.name, from.level);
        const to_ = getAncestor(to.name, to.level);
        const from_id_ = `[${from_}]`;
        const to_id_ = `[${to_}]`;
        const id_ = `[${from.name}]>-(${edge.topic})->[${to.name}]`;
        
        const displayEdge = displayEdgesDS.get(id_);
        displayEdge.from = from_id_;
        displayEdge.to = to_id_;
        displayEdgesDS.update(displayEdge);
    }
}

window.hideSelected = () => {
    const selectedNodes = network.getSelectedNodes();
    const selectedEdges = network.getSelectedEdges();

    const ids1 = Array.from(selectedNodes).flatMap(id_ => displayNodesDS.get(id_).node_sources);
    const ids2 = Array.from(selectedEdges).map(id_ => displayEdgesDS.get(id_).node_source);
    for (const id of ids1)
        hideNode(id);
    for (const id of ids2)
        hideEdge(id);
};

window.showAll = () => {
    updateSession(() => {
        let updated = false;
        nodesDS.forEach(node => {
            if (!node.show) {
                showNode(node.id);
                updated = true;
            }
        });
        edgesDS.forEach(edge => {
            if (!edge.show) {
                showEdge(edge.id);
                updated = true;
            }
        });
        return updated;
    });
};

window.nodeUp = () => {
    const selectedNodes = network.getSelectedNodes();
    const ids = Array.from(selectedNodes).flatMap(id_ => displayNodesDS.get(id_).node_sources);
    updateSession(() => {
        for (const id of ids)
            adjustNodeLevel(id, 1);
        return ids.length > 1;
    });
    network.unselectAll();
    const ids_ = nodesDS.get(ids).map(node => getAncestor(node.name, node.level)).map(name_ => `[${name_}]`);
    network.selectNodes(ids_);
};

window.nodeDown = () => {
    const selectedNodes = network.getSelectedNodes();
    const ids = Array.from(selectedNodes).flatMap(id_ => displayNodesDS.get(id_).node_sources);
    updateSession(() => {
        for (const id of ids)
            adjustNodeLevel(id, -1);
        return ids.length > 1;
    });
    network.unselectAll();
    const ids_ = nodesDS.get(ids).map(node => getAncestor(node.name, node.level)).map(name_ => `[${name_}]`);
    network.selectNodes(ids_);
};

window.refresh = async () => {
    const response = await fetch('/api/graph');
    const rawData = await response.json();
    if (rawData.error) {
        alert(rawData.error);
        return;
    }
    const visData = processRosGraph(rawData);
    const newNodesDS = new vis.DataSet(visData.nodes);
    const newEdgesDS = new vis.DataSet(visData.edges);
    
    updateSession(() => {
        let updated = false;
        edgesDS.forEach(edge => {
            if (!newEdgesDS.get(edge.id)) {
                window.hideEdge(edge.id);
                edgesDS.remove(edge.id);
                updated = true;
            }
        });
        nodesDS.forEach(node => {
            if (!newNodesDS.get(node.id)) {
                window.hideNode(node.id);
                nodesDS.remove(node.id);
                updated = true;
            }
        });
        newNodesDS.forEach(node_ => {
            if (!nodesDS.get(node_.id)) {
                nodesDS.add(node_);
                window.showNode(node_.id);
                updated = true;
            }
        });
        newEdgesDS.forEach(edge_ => {
            if (!edgesDS.get(edge_.id)) {
                edgesDS.add(edge_);
                window.showEdge(edge_.id);
                updated = true;
            }
        });
        return updated;
    });
};

window.closePanel = () => {
    document.getElementById('info-panel').style.display = 'none';
};

let info_topic = "";

window.updatePanel = async () => {
    const panel = document.getElementById('info-panel');
    const title = document.getElementById('panel-title');
    const hzEl = document.getElementById('topic-hz');
    const msgEl = document.getElementById('topic-msg');

    // Show loading state
    panel.style.display = 'flex';
    title.innerText = info_topic;
    hzEl.innerText = "loading...";
    msgEl.innerText = "Executing rostopic echo...";

    try {
        const response = await fetch(`/api/topic_info${info_topic}`);
        if (!response.ok) throw new Error("Server error");
        
        const data = await response.json();
        
        // Update UI
        hzEl.innerText = data.frequency || "0.0";
        msgEl.innerText = data.last_message || "No message received.";
    } catch (err) {
        msgEl.innerText = "Error: " + err.message;
        hzEl.innerText = "N/A";
    }
};

async function initGraph() {
    const container = document.getElementById('network-container');
    network = new vis.Network(container, { nodes: displayNodesDS, edges: displayEdgesDS }, options);

    container.addEventListener("keypress", event => {
        if (event.key == "[") {
            window.nodeUp();
        } else if (event.key == "]") {
            window.nodeDown();
        } else if (event.key == "d") {
            window.hideSelected();
        } else if (event.key == "D") {
            window.showAll();
        }
    });

    network.on("doubleClick", async (params) => {
        if (params.nodes.length > 0) {
            const nodeId = params.nodes[0];
            const displayNode = displayNodesDS.get(nodeId);
            if (displayNode.fixed) {
                displayNode.fixed = false;
                displayNodesDS.update(displayNode);
            } else {
                const pos = network.getPositions([nodeId])[nodeId];
                displayNode.x = pos.x;
                displayNode.y = pos.y;
                displayNode.fixed = true;
                displayNodesDS.update(displayNode);
            }
        } else if (params.nodes.length === 0 && params.edges.length == 0) {
            await window.refresh();
        } else if (params.nodes.length === 0 && params.edges.length > 0) {
            const edgeId = params.edges[0];
            const displayEdge = displayEdgesDS.get(edgeId);
            info_topic = edgesDS.get(displayEdge.node_source).topic;
            await window.updatePanel();
        }
    });

    network.on("dragStart", ({nodes}) => {
        displayNodesDS.update(
            displayNodesDS.get(nodes)
                .map(({fixed, x, y, ...node}) => ({...node, fixed: false, fixed_origin: fixed ?? false}))
        );
    })
    network.on("dragEnd", ({nodes}) => {
        const positions = network.getPositions(nodes);
        displayNodesDS.update(
            displayNodesDS.get(nodes)
                .map(({fixed_origin, x, y, ...node}) => ({...node, ...positions[node.id], fixed: fixed_origin}))
        );
    })
}

initGraph();
