# Cómo funciona Pterodactyl con Docker

## Arquitectura

Pterodactyl usa Docker para aislar cada servidor de juego en contenedores. La arquitectura es:

```
Panel (Web UI + API)
    │
    ▼
Wings (Daemon en cada nodo)
    │
    ▼
Docker Engine
    │
    ▼
Contenedores (un servidor = un contenedor)
```

## Gestión de recursos

### CPU

Docker permite dos modos de límite de CPU:

1. **`--cpus`**: Limita el uso total de CPU (ej: `--cpus=2` = máximo 2 cores)
2. **`--cpu-shares`**: Prioridad relativa entre contenedores (no es un límite duro)

Pterodactyl usa **`--cpus`** para establecer límites. Si un servidor tiene 200% CPU asignado, puede usar hasta 2 cores completos.

**Comportamiento**:
- Docker **no apaga** el contenedor si excede el límite
- Docker **throttlea** (reduce) el proceso automáticamente
- El servidor sigue corriendo pero más lento

### RAM

```bash
docker run --memory=4g --memory-swap=4g
```

- `--memory`: Límite de RAM
- `--memory-swap`: RAM + Swap (igual que memory = sin swap)

**Comportamiento cuando se excede**:
- Docker envía señal OOM (Out of Memory)
- El contenedor **se mata** (OOM Killer)
- Wings detecta esto y marca el servidor como "crashed"

### Disco

Pterodactyl **no usa límites de Docker para disco**. En su lugar:

1. Cada servidor tiene un directorio en el host
2. Wings ejecuta un **cron job** que calcula el uso de disco
3. Si excede el límite, Wings puede:
   - Bloquear escrituras (suspender servidor)
   - Notificar al usuario
   - Apagar el servidor

### I/O de disco

```bash
docker run --device-write-bps=/dev/sda:50mb
```

Pterodactyl puede limitar velocidad de lectura/escritura pero no es común usarlo.

## Comparación con v87 (QEMU/KVM)

| Recurso | Pterodactyl (Docker) | v87 (QEMU/KVM) |
|---------|---------------------|----------------|
| CPU | Throttling automático | Límite duro por vCPUs |
| RAM | OOM Kill si excede | Límite duro, no puede exceder |
| Disco | Monitoreo externo | Imagen qcow2 con tamaño fijo |
| Aislamiento | Namespaces/cgroups | Virtualización completa |
| Overhead | Mínimo (~1-2%) | Mayor (~5-10%) |

## Implementar estilo Pterodactyl en v87

Para replicar el comportamiento de "apagar si excede límite":

### CPU Burst con límite

```javascript
// En vez de limitar CPU duro, monitorear uso
async function monitorCpuUsage(vmId) {
    const stats = await getVmStats(vmId);
    const limit = server.cpuLimit; // ej: 400 = 4 cores
    
    if (stats.cpuPercent > limit) {
        // Dar gracia de X segundos
        if (exceedingFor > CPU_GRACE_PERIOD) {
            await stopServer(vmId, 'CPU limit exceeded');
            notifyUser(server.userId, 'Server stopped: CPU limit exceeded');
        }
    }
}
```

### RAM con OOM-style

```javascript
async function monitorRamUsage(vmId) {
    const stats = await getVmStats(vmId);
    const limitMB = server.ram;
    
    if (stats.ramUsedMB > limitMB * 1.1) { // 10% grace
        await stopServer(vmId, 'RAM limit exceeded');
    }
}
```

### Disco con monitoreo

```javascript
async function checkDiskUsage(vmId) {
    const usedGB = await calculateDiskUsage(server.dataPath);
    const limitGB = parseInt(server.diskSize);
    
    if (usedGB > limitGB) {
        await suspendServer(vmId);
        notifyUser(server.userId, 'Server suspended: Disk limit exceeded');
    }
}
```

## Ventajas del modelo Pterodactyl

1. **Overselling**: Puedes vender más CPU de la que tienes físicamente
2. **Burst**: Servidores pueden usar más CPU temporalmente si hay disponible
3. **Eficiencia**: Recursos no usados están disponibles para otros

## Desventajas

1. **Noisy neighbors**: Un servidor puede afectar a otros
2. **Inconsistencia**: Rendimiento varía según carga del nodo
3. **Menos aislamiento**: Vulnerabilidades de kernel afectan a todos

## Configuración sugerida para v87

```json
{
  "resources": {
    "cpuMode": "burst",        // "strict" | "burst"
    "cpuGracePeriod": 30,      // segundos antes de apagar
    "ramMode": "strict",       // siempre estricto en VMs
    "diskCheckInterval": 300,  // segundos entre checks
    "allowOversell": false     // permitir vender más de lo disponible
  }
}
```
