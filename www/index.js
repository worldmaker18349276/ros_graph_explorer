import cytoscape from './cytoscape.esm.min.mjs';

const cy = cytoscape({
  container: document.getElementById('cy'), // container to render in

  elements: [ // list of graph elements
    { data: { id: 'node1', label: 'Robot' } },
    { data: { id: 'node2', label: 'Sensor' } },
    { data: { id: 'edge1', source: 'node1', target: 'node2' } }
  ],

  style: [ // the stylesheet for the graph
    {
      selector: 'node',
      style: {
        'background-color': '#666',
        'label': 'data(label)',
        'color': '#333',
        'font-size': '12px'
      }
    },
    {
      selector: 'edge',
      style: {
        'width': 3,
        'line-color': '#ccc',
        'target-arrow-color': '#ccc',
        'target-arrow-shape': 'triangle',
        'curve-style': 'bezier'
      }
    }
  ],

  layout: {
    name: 'grid',
    rows: 1
  }
});
