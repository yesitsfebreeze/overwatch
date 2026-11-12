set shell := ["bash", "-cu"]
set windows-shell := ["C:/Program Files/Git/bin/bash.exe", "-cu"]

exe := if os() == "windows" { "exe" } else { "bin" }
python := if os() == "windows" { "python" } else { "python3" }

ollama session="" *args:
    {{python}} -I tools/strip_images.py "{{session}}" || echo "strip skipped/failed"
    ollama launch claude --model deepseek-v4.1-flash:cloud -- --dangerously-skip-permissions {{ if session != "" { "--resume " + session } else { "" } }} {{args}}

