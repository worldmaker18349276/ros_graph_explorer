#!/usr/bin/env python3
from flask_cors import CORS
from flask import Flask, jsonify, send_from_directory, Response
import rospy
import rosgraph
import rosservice
import threading
import time
import os
import subprocess
import shlex
import signal
import re
import yaml
import json

port = 5000
root = ""

app = Flask(__name__)
CORS(app)

NODE_TYPE_CACHE = {}

def get_node_executable(node_name):
    if node_name in NODE_TYPE_CACHE:
        return NODE_TYPE_CACHE[node_name]

    try:
        cmd = f"source /opt/ros/noetic/setup.bash && rosnode info {node_name}"
        output = subprocess.check_output(
            cmd, shell=True, executable='/bin/bash', stderr=subprocess.STDOUT, timeout=1.0
        ).decode('utf-8')

        pid = None
        for line in output.split('\n'):
            if "Pid:" in line:
                pid = line.split(":")[1].strip()
                break
        
        if pid and pid != "None":
            # 'args' gives the full command: "python3 /path/to/my_script.py --args"
            ps_cmd = f"ps -p {pid} -o args="
            full_args = subprocess.check_output(ps_cmd, shell=True).decode('utf-8').strip()
            
            parts = full_args.split()
            if not parts: return "unknown"

            # If it's a python node, the script is usually the second argument
            if "python" in parts[0].lower() and len(parts) > 1:
                # Get the filename from the path
                exe_name = os.path.basename(parts[1])
            else:
                # For C++ nodes, the first part is the binary path
                exe_name = os.path.basename(parts[0])

            NODE_TYPE_CACHE[node_name] = exe_name
            return exe_name
            
    except Exception:
        pass
    
    return "unknown"

# {
#    frequency: number,
#    message: string,
#    error: string,
# }
@app.route('/api/topic_info/<path:topic>')
def topic_info(topic):
    topic = "/" + topic

    def generate():
        # Start rostopic echo as a subprocess
        process = subprocess.Popen(
            ['rostopic', 'echo', topic],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True
        )

        last_update_time = 0
        msg_count = 0
        start_time = time.time()
        buffer = ""
        
        try:
            print(f"start monitoring {topic}...")
            for line in iter(process.stdout.readline, ""):
                if line.strip() != "---":
                    buffer += line
                    continue

                # We reached the end of a message block
                try:
                    current_time = time.time()
                    msg_count += 1
                    
                    # Calculate rolling frequency
                    elapsed = current_time - start_time
                    freq = msg_count / elapsed if elapsed > 0 else 0
                    
                    # THROTTLE: Only send if 0.5s (2Hz) has passed since last send
                    if current_time - last_update_time >= 0.5:
                        parsed_content = yaml.safe_load(buffer)
                        
                        payload = {
                            "frequency": round(freq, 2),
                            "message": parsed_content,
                            "error": None
                        }
                        
                        yield f"data: {json.dumps(payload)}\n\n"
                        last_update_time = current_time
                        
                except Exception as e:
                    yield f"data: {json.dumps({'frequency': 0, 'message': None, 'error': str(e)})}\n\n"
                
                buffer = "" # Reset buffer for next message

        finally:
            process.terminate()
            print(f"stop monitoring {topic}")

    return Response(generate(), mimetype='text/event-stream')

# {
#    publishers: {topic: string, nodes: string[]}[],
#    subscribers: {topic: string, nodes: string[]}[],
#    node_types: {node: string, type: string}[],
#    topic_types: {topic: string, type: string}[],
# }
@app.route('/api/graph')
def get_graph():
    master = rosgraph.Master('/graph_explorer')
    try:
        pubs, subs, srvs = master.getSystemState()

        all_nodes = set()
        for _, nodes in pubs:
            for node in nodes:
                all_nodes.add(node)
        for _, nodes in subs:
            for node in nodes:
                all_nodes.add(node)
        for _, nodes in srvs:
            for node in nodes:
                all_nodes.add(node)

        publishers = [{"topic": topic, "nodes": nodes} for topic, nodes in pubs]
        subscribers = [{"topic": topic, "nodes": nodes} for topic, nodes in subs]
        topic_types = [{"topic": t, "type": type_str} for t, type_str in master.getTopicTypes()]
        node_types = [{"node": node, "type": get_node_executable(node)} for node in all_nodes]

        return jsonify({
            "publishers": publishers,
            "subscribers": subscribers,
            "node_types": node_types,
            "topic_types": topic_types,
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/')
def index():
    return send_from_directory(root, 'index.html')

@app.route('/<path:path>')
def static_files(path):
    return send_from_directory(root, path)

if __name__ == "__main__":
    rospy.init_node('graph_server', anonymous=True, disable_signals=True)
    root = rospy.get_param('~root')
    port = rospy.get_param('~port', port)
    app.run(host='0.0.0.0', port=port)
