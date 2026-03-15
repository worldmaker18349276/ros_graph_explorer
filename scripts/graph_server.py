#!/usr/bin/env python3
from flask_cors import CORS
from flask import Flask, jsonify, send_from_directory
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

def get_rostopic_hz(topic, window=5, duration=2.0):
    """
    Runs rostopic hz, waits for 'duration' seconds, 
    then kills it and returns the captured output.
    """
    cmd = f"source /opt/ros/noetic/setup.bash && rostopic hz {topic} -w {window}"
    
    # Start the process in a new process group so we can kill it easily
    process = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        shell=True,
        executable='/bin/bash',
        preexec_fn=os.setsid 
    )

    try:
        # Wait for the specified duration to gather samples
        time.sleep(duration)
        
        # Kill the process group
        os.killpg(os.getpgid(process.pid), signal.SIGTERM)
        
        # Read what was captured
        stdout, stderr = process.communicate(timeout=1.0)
        output = stdout.decode('utf-8')
        
        # Parse the 'average rate' line
        if "average rate:" in output:
            # Splits by 'average rate:' and takes the next numerical value
            return output.split("average rate:")[1].split('\n')[0].strip()
        else:
            return "inf"
            
    except Exception as e:
        return f"Error: {str(e)}"

def run_ros_command(cmd, timeout):
    """
    Executes a ROS command. If it times out, it kills the entire 
    process group to ensure no hanging ROS subscribers remain.
    """
    full_cmd = f"source /opt/ros/noetic/setup.bash && {cmd}"
    
    # Use start_new_session=True (or preexec_fn=os.setsid) 
    # to create a process group
    process = subprocess.Popen(
        full_cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        shell=True,
        executable='/bin/bash',
        start_new_session=True 
    )

    try:
        # Wait for the output
        stdout, stderr = process.communicate(timeout=timeout)
        return stdout.decode('utf-8').strip()

    except subprocess.TimeoutExpired:
        # 1. Kill the entire process group
        os.killpg(os.getpgid(process.pid), signal.SIGTERM)
        
        # 2. Cleanup and return a clean error
        process.communicate() # Final cleanup
        return f"TIMEOUT: No message received after {timeout} seconds."
        
    except Exception as e:
        if process.pid:
            os.killpg(os.getpgid(process.pid), signal.SIGTERM)
        return f"ERROR: {str(e)}"

@app.route('/api/topic_info/<path:topic>')
def get_topic_info(topic):
    topic = "/" + topic
    
    msg = run_ros_command(f"rostopic echo {topic} -n 1", 5.0)
    freq = get_rostopic_hz(topic, 5, 2.0)

    return jsonify({
        "topic": topic,
        "frequency": freq,
        "last_message": msg
    })

@app.route('/api/graph')
def get_graph():
    master = rosgraph.Master('/graph_explorer')
    try:
        pubs, subs, srvs = master.getSystemState()
        topic_types = {t: type_str for t, type_str in master.getTopicTypes()}
        node_types = {}

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
        for node in all_nodes:
            node_types[node] = get_node_executable(node)

        return jsonify({
            "publishers": pubs,
            "subscribers": subs,
            "node_metadata": node_types,
            "topic_metadata": topic_types,
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
