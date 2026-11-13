#!/bin/sh
# Starts GeneSense at power-on as a system service (instead of the M10 menu's "Auto boot").
#   sh tools/autostart.sh install   turn it on (then restart the M10)
#   sh tools/autostart.sh remove    turn it off
#   sh tools/autostart.sh status    is it running?
#   sh tools/autostart.sh log       the program's last lines
DIR=$(cd "$(dirname "$0")/.." && pwd)
UNIT=/etc/systemd/system/genesense.service

case "$1" in
install)
    cat > "$UNIT" <<UNITEOF
[Unit]
Description=GeneSense measuring device
After=multi-user.target

[Service]
Type=simple
WorkingDirectory=$DIR
Environment=DISPLAY=:0
Environment=XAUTHORITY=/root/.Xauthority
Environment=PYTHONUNBUFFERED=1
ExecStartPre=/bin/sh $DIR/tools/autostart.sh wait
ExecStart=/usr/bin/python3 $DIR/genesense.py
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNITEOF
    systemctl daemon-reload && systemctl enable genesense.service && \
        echo "Done. Turn OFF 'Auto boot' in the M10 menu (Service Toggle), then restart the M10."
    ;;
remove)
    systemctl disable --now genesense.service 2>/dev/null
    rm -f "$UNIT"
    systemctl daemon-reload
    echo "GeneSense no longer starts at power-on."
    ;;
status)
    systemctl status genesense.service --no-pager
    ;;
log)
    tail -n 40 "$DIR/data/genesense.log"
    ;;
wait)
    # wait (up to 90 s) for the screen's X server, then a little more for the M10's own menu to start
    i=0
    while [ $i -lt 90 ] && [ ! -S /tmp/.X11-unix/X0 ]; do sleep 1; i=$((i + 1)); done
    sleep 4
    ;;
*)
    echo "Usage: sh tools/autostart.sh install | remove | status | log"
    ;;
esac
