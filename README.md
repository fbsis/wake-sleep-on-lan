# Wake / Sleep on LAN (Node + Bash)

Projeto simples para:
- **Acordar** uma máquina via Wake-on-LAN.
- **Dormir/Desligar** uma máquina via comando SSH.

## Como funciona
- O servidor Node expõe uma UI com dois botões: **Acordar** e **Desligar**.
- O desligamento executa um comando remoto via SSH no Proxmox.

## Requisitos
- Node.js 18+ (para os scripts em `src/`)
- Acesso SSH ao Proxmox com permissão para executar o comando de sleep

## Instalação
```bash
npm install
```

## Subir o servidor (UI)
```bash
PORT=8080 \
WAKE_MAC=00:11:22:33:44:55 \
WAKE_BROADCAST=255.255.255.255 \
WAKE_PORT=9 \
SLEEP_HOST=192.168.1.50 \
SSH_PORT=22 \
SSH_USER=root \
SSH_PASS="SUA_SENHA" \
SLEEP_COMMAND="/usr/sbin/ethtool -s nic0 wol g && /bin/systemctl suspend" \
npm run server
```

Abra no navegador: `http://SEU_IP:8080`

O status na UI usa `ping` para detectar se o servidor está online.

## Segurança
- Use uma senha forte no SSH ou considere trocar para chave privada.
- Mantenha o SSH restrito à rede interna.
