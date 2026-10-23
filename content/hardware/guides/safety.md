---
id: safety
title: Safety and lab discipline
order: 7
summary: Physical safety with servers and optics, why labs never run on production gear, change control for a home lab, firmware risk, and what the toolkit collects and exposes.
---

## Physical safety

### Electrical and ESD

- Power off and unplug a server before opening it, and wait for the standby LEDs to go out. Many
  servers have two power supplies: unplug both.
- Handle NICs and GPUs by their edges and brackets, on an anti-static mat or with a wrist strap
  connected to the chassis. Keep cards in anti-static bags until they go in.
- GPUs need the correct auxiliary power cables for that server or PSU. Cables from other models can
  look identical and have different pinouts; use the vendor's cable.
- Do not overload a circuit or a power strip. Servers, switches and especially GPU nodes draw far
  more than desktop equipment; check the rating of what you plug into.

### Laser safety with optics

- **Never look into a fibre end, a transceiver port or an unplugged optical cable**, and never
  through a magnifier or microscope at a connector that might be live. The light is infrared:
  you cannot see it, and you will not blink.
- Most data-center transceivers are Class 1 laser products under normal operation, but longer-reach
  and some single-mode optics can be rated higher, and a broken or open fibre path is not "normal
  operation". Treat every fibre as live.
- Put dust caps on unused transceivers and fibre ends. A dirty connector is the most common cause of
  a flaky optical link; clean with proper fibre cleaning tools, and inspect with a fibre scope that
  is designed for it.
- AOCs and DACs have no exposed laser at the ends, which is one more reason they are the easiest
  choice for a home lab.

### Heat and airflow

- 100G-class NICs, optics and switch ASICs run hot. A transceiver that has just been pulled can be
  hot enough to hurt.
- Server cards rely on chassis airflow. In a tower or open bench, add directed airflow over the NIC
  and GPU, or they throttle, log thermal errors or shut down. Many NICs report module and ASIC
  temperatures; hw-05 shows where.
- Keep blanking panels and airflow direction consistent in a rack; do not block intake or exhaust.

## Never on production or shared gear

The labs change NIC QoS, MTUs and port states, inject faults, and saturate links. Run them only on
equipment that is **yours and dedicated to the lab**:

- Not on a production AI cluster, not on a shared university or company test bed, not on a switch
  that also carries other people's traffic, and not on a host whose data interface is also its SSH
  interface.
- If you are learning at work, ask for a dedicated, isolated set of machines and the written
  agreement of the people who own them.
- Cloud bare-metal instances: read the provider's terms before generating heavy traffic or changing
  NIC settings; many restrict both.

## Change control for your lab

Professional habits, scaled down. They also make the labs much easier to debug.

1. **One change at a time.** Make it, verify it, write it down. If you change three things and the
   fabric breaks, you have three suspects.
2. **Save before you change.** Every lab that changes settings (`changes_config: true` on its card)
   ships a save script and a restore script, and saves state under `/var/lib/aina/state/<lab>/`. Run the
   save step even when you think you will remember the old values.
3. **Back up the switch** before every Tier 2 session (see
   [Network and switch setup](#/hw/network-setup)).
4. **Keep a lab notebook.** Date, what you changed, the command, what you expected, what you saw.
   A plain Markdown file in the repository works. Paste the `aina-hw summary` output before and
   after a session.
5. **Run the restore step** at the end of every lab, then re-run `aina-hw collect-all` and confirm the
   health review on the [Connect page](#/hw/connect) is back to your baseline.
6. **Know your way back in.** Keep management access (SSH over the management network, BMC console)
   independent of everything the labs touch.

## Firmware updates

Firmware updates are the one operation in this course that can turn a working card into a broken
one.

- Update only if you need to (for example, mismatched versions between hosts or a known bug); the
  labs do not need the newest firmware.
- Use only the image for the card's exact **PSID**. OEM cards usually need the OEM's image.
- Read the release notes. Never interrupt a burn; make sure power is stable.
- Changes made with `mlxconfig` (port type, SR-IOV and similar) persist in the card and apply
  after a reset; record them like any other change.

## Data: what the toolkit collects

`aina-hw collect` is read-only: it reads sysfs and procfs and runs "show" commands
(`ethtool`, `ip`, `rdma`, `ibv_devinfo`, `mlnx_qos` or `dcb`, `lldpcli`, `nvidia-smi`). The report
contains:

| Collected | Examples |
|---|---|
| Host | hostname, OS, kernel, CPU model, NUMA node count, memory, IOMMU-related kernel flags, CPU governor, memlock limit |
| Software | rdma-core, perftest, OFED/DOCA and NVIDIA driver versions, which tools are installed, loaded RDMA/GPU modules |
| RDMA devices | name, firmware, board ID, node GUID, PCI address, NUMA node, PCIe speed and width, port state, rate, link layer, LIDs, active MTU, GID table, port and hardware counters |
| Netdevs | MTU, state, speed, MAC, IPv4 addresses, driver and firmware, pause settings, QoS (trust, PFC, DSCP map), RoCE ECN switches where exposed, selected `ethtool -S` counters, LLDP neighbour |
| GPUs | index, model, PCI address, driver; `nvidia-smi topo -m` |

It does **not** collect passwords, keys, files, process lists, traffic contents or anything
outside the networking/RDMA/GPU inventory.

### Redact before you share

```bash
./hw-toolkit/aina-hw collect-all --redact
```

`--redact` replaces hostnames with a short hash and removes node GUIDs, MAC addresses and the
interface IDs of every GID that is not IPv4-mapped (they derive from the MAC or port GUID). It keeps IP addresses (including the IPv4-mapped GIDs, which contain
them), interface names, LLDP neighbour names and the GPU topology table. **Read the JSON before you
post it anywhere**; a lab on private addresses usually has nothing sensitive left, but you are the
judge.

## The local agent's security model

`aina-hw serve` lets the [Connect page](#/hw/connect) read your latest report and check results
directly. It is designed to be boring:

- **Read-only.** It answers four GET endpoints: `/api/status`, `/api/report` and `/api/checks` from
  files in `labs/hw-toolkit/results/`, and `/api/live`, which reads the lab port's counters (sysfs,
  `ethtool -S`) for the ports named in `lab.env`. Nothing in a request reaches a command. Only with
  `--live-remote` does it also open one SSH session per remote host (the same read-only collection
  path as `collect-all`), and only while the Live view is polling.
- **Localhost only by default.** It binds `127.0.0.1:8765`. Binding to another address prints a
  warning, because it would expose your inventory to the network.
- **Origin allow-list.** Browsers only get CORS permission for the academy's published site and for
  `http://localhost` / `http://127.0.0.1` on any port (the local launcher). Add others explicitly
  with `--allow-origin`. `--allow-any-origin` exists but lets any web page you visit read the data
  while the agent runs; avoid it.
- **Remote hosts via SSH.** When the agent runs on host A and your browser on a laptop, forward the
  port over the management network instead of opening it:

  ```bash
  ssh -L 8765:127.0.0.1:8765 {{SSH_USER}}@{{HOST_A}}
  ```

- Stop it with Ctrl-C when you are done. If you prefer no network path at all, skip the agent and
  import the JSON files on the Connect page; nothing leaves your browser either way.

## Cleaning up

At the end of a session:

- [ ] Run the **Restore** section of every lab you worked on (and check the result).
- [ ] Remove fault injections (hw-04 has its own restore).
- [ ] Return switch configuration to your baseline (or the saved revision).
- [ ] Re-run `aina-hw collect-all` and compare the health review with your baseline.
- [ ] Stop `aina-hw serve`, OpenSM (if you started it by hand), and any long-running perftest.
- [ ] Power down what you do not need: it is quieter, cooler and cheaper.
