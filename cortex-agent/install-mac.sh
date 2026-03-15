#!/bin/bash
echo ""
echo "  CORTEX Desktop Agent v1.0 - Installation"
echo "  ─────────────────────────────────────────"
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "[FEHLER] Node.js nicht gefunden."
    echo "Installiere mit: brew install node  oder  https://nodejs.org"
    exit 1
fi
echo "[OK] Node.js $(node --version) gefunden"

# Install socket.io-client
npm install socket.io-client --save > /dev/null 2>&1
echo "[OK] Dependencies installiert"
echo ""

# Get token
read -p "Dein CORTEX Agent-Token (aus dem User Panel): " TOKEN
if [ -z "$TOKEN" ]; then
    echo "[FEHLER] Kein Token eingegeben!"
    exit 1
fi

# Create startup script
cat > start-cortex-agent.sh << EOF
#!/bin/bash
node cortex-agent.js --token $TOKEN --server http://187.77.70.209:8201
EOF
chmod +x start-cortex-agent.sh

echo ""
echo "[OK] Installation abgeschlossen!"
echo ""
echo "Starte mit: ./start-cortex-agent.sh"
echo ""
./start-cortex-agent.sh
