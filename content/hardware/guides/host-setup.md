---
id: host-setup
title: Host setup
order: 3
summary: Prepare each server for the hardware labs, from BIOS and driver stack to firmware, port type, data-interface addressing, SSH, memlock and a first inventory.
---

## The goal

At the end of this guide every host has:

- the same OS, kernel and RDMA driver stack;
- an RDMA NIC with current-enough firmware, in the right port type (Ethernet or InfiniBand);
- a data interface with a static IP and the lab MTU, separate from the management interface;
- the lab tools (`setup-rdma-host.sh`), an unlimited memlock limit, synchronised time;
- key-based SSH from host A to the other hosts;
- a first inventory collected with `aina-hw` and imported on the [Connect page](#/hw/connect).

Fill in your profile on the [Connect page](#/hw/connect) first: every command below is
personalised with it. Commands are shown for host A; repeat them on each host with that host's
values ({{B_NETDEV}}, {{B_IP}}, ...).

## 1. Operating system

- Install **Ubuntu 24.04 LTS server** (the tested-by-design target) or a RHEL 9 family
  distribution. Use the same release on every host.
- Prefer the **generic** kernel. Cloud and vendor-tuned kernels can package or omit RDMA modules
  differently.
- Give the management interface (the one you SSH to) its own address, ideally on its own network.
  The RDMA port is the **data** interface and gets configured separately below. Never run lab
  traffic over the interface you depend on for SSH: some labs deliberately break the data path.
- Install the repository on every host at the same path ({{AINA_DIR}}):

  ```bash
  git clone <repository URL> {{AINA_DIR}}
  ```

## 2. BIOS and platform settings to check

There is no universal "RDMA BIOS profile"; these are the settings worth knowing, with their
trade-offs. Change one at a time and write down what you changed.

| Setting | What it does | Lab guidance |
|---|---|---|
| Power profile / C-states | Deep CPU sleep states save power but add wake-up latency | A "performance" or "maximum performance" profile gives steadier latency numbers in hw-02. Not required for correctness. |
| SR-IOV | Lets the NIC expose virtual functions | Not needed by these labs. Leave it at the default. |
| IOMMU (VT-d / AMD-Vi) | Address translation and isolation for devices | Needed for VFIO/virtualisation. With the IOMMU in translation mode, peer-to-peer and DMA performance can suffer on some platforms; some deployments use passthrough mode. Do not change it blindly; see the GPUDirect notes below. |
| PCIe ACS (Access Control Services) | Forces peer-to-peer traffic up to the root complex for isolation | Matters for Tier 3: ACS on a PCIe switch between GPU and NIC can redirect GPUDirect traffic and cut its performance. NVIDIA's GPUDirect documentation describes how to check it (`lspci -vvv` shows `ACSCtl`). |
| PCIe bifurcation | Splits a x16 slot into x8+x8 or x4x4x4x4 | Only for risers and multi-device cards. A NIC in a bifurcated slot gets fewer lanes. |
| ASPM (PCIe power management) | Lets idle links enter low-power states | Usually harmless for NICs; if you see unexplained latency spikes, it is one of the things to test. |
| Slot speed forcing | Some BIOSes let you force a slot to an older PCIe generation | Leave it on Auto; hw-01 checks that the NIC negotiates its maximum. |

> [!NOTE]
> GPU servers from OEMs often have documented "GPUDirect" or "AI" BIOS presets. If your vendor
> publishes one, start from it rather than tuning by hand.

## 3. Choose and install the driver stack

You have two valid options. Pick one and use it on **every** host.

| | Inbox (distribution) | NVIDIA DOCA-Host (successor of MLNX_OFED) |
|---|---|---|
| Where it comes from | The kernel's `mlx5_core`/`mlx5_ib` drivers + distribution rdma-core | NVIDIA's packages for your exact OS release |
| Effort | None: it is already there | Download and install per NVIDIA's instructions; depending on the packaging, kernel modules are rebuilt (DKMS) or come as signed prebuilt packages for your kernel |
| RDMA device names | From the PCI address, for example `rocep3s0f0` | `mlx5_0`, `mlx5_1`, ... |
| Extra tools | Generic tools only: `rdma`, `dcb`, `ethtool`, sysfs and configfs | NVIDIA scripts used by some tasks: `mlnx_qos`, `show_gids`, `ibdev2netdev`, `cma_roce_tos`, `cma_roce_mode`, `ofed_info`; the `/sys/class/net/<netdev>/ecn/` DCQCN switches |
| Good for | All labs (tasks that need NVIDIA-only scripts say so and give a generic alternative where one exists) | Matching what many production AI clusters run |

The NVIDIA scripts are not in the distribution archives. Their inbox equivalents: `dcb pfc`, `dcb app`,
`dcb ets` and `dcb buffer` for `mlnx_qos`; `/sys/class/infiniband/<dev>/ports/1/gids/N` and
`gid_attrs/types/N` for `show_gids`; `rdma link show` for `ibdev2netdev`; the rdma_cm configfs files
(`/sys/kernel/config/rdma_cm/<dev>/ports/1/default_roce_tos` and `default_roce_mode`) for `cma_roce_tos`
and `cma_roce_mode`.

Install DOCA-Host following NVIDIA's DOCA installation guide for your distribution; the package
names and repository setup change between releases, so this course does not repeat them.

> [!WARNING]
> Do **not** mix the two: installing distribution rdma-core packages on top of DOCA/OFED, or the
> reverse, produces conflicting libraries and providers that fail in confusing ways.
> `setup-rdma-host.sh` detects an existing OFED/DOCA install (via `ofed_info`) and leaves its RDMA
> packages alone.

## 4. Run the setup script

On every host:

```bash
cd {{AINA_DIR}}/labs/hw-toolkit
chmod +x aina-hw setup-rdma-host.sh
./setup-rdma-host.sh                   # installs tools, then audits the host
./setup-rdma-host.sh --check           # audit only, installs nothing
```

| Option | Effect |
|---|---|
| `--check` | Audit only: tools, kernel modules, RDMA devices, memlock, CPU governor, IOMMU flags, GPU stack |
| `--opensm` | Also install OpenSM (InfiniBand labs without a managed switch) |
| `--no-lldp` | Do not install lldpd |
| `--set-memlock` | Write `/etc/security/limits.d/90-aina-rdma.conf` with an unlimited memlock limit, if it is not already unlimited |

The script supports apt (Ubuntu/Debian) and dnf (RHEL family). It installs packages and can
write the memlock file; it never changes NIC, switch, firmware or kernel settings. Every `[todo]`
line in its output is something to fix before the labs.

## 5. Firmware: query, and update only with care

If you have NVIDIA Firmware Tools (MFT, bundled with DOCA or installed separately):

```bash
sudo mlxfwmanager --query              # adapters, PSID, current firmware (add --online to look up updates)
sudo mst start && sudo mst status      # MST device names for flint/mlxconfig/mlxlink
sudo flint -d /dev/mst/<device> q      # the burned image: version, PSID, GUIDs/MACs
```

Without MFT, the firmware version is still visible: `ethtool -i {{A_NETDEV}}` (`firmware-version`,
with the PSID in brackets), `devlink dev info` (`fw.psid`, `fw.version`) and
`cat /sys/class/infiniband/{{A_RDMA_DEV}}/fw_ver`. hw-01 compares it across hosts.

> [!NOTE]
> Recent MFT reaches the adapter without its kernel modules: `mst start` may load and immediately
> unload them ("(unused)") without creating `/dev/mst` devices, and the tools take the PCI address
> (`-d 03:00.0`) or the RDMA device name instead. With **UEFI Secure Boot** on, the kernel's lockdown
> mode blocks that access: `mlxfwmanager --query` finds no devices, `mlxconfig` fails with `-E- Failed to open the device` and
> `flint` with `-E- Cannot open Device: mlx5_0.`. Recent kernels with recent MFT list a
> `/dev/fwctl/fwctlN` device in `mst status -v`, and `mlxlink -d /dev/fwctl/fwctl0` works through it,
> but `mlxconfig` still cannot read NV configuration (`... or HW access is disabled`) and `flint`
> reports `Operation not supported`. Query
> firmware with `ethtool -i` or `devlink dev info` instead; for changes, see the next section.

> [!WARNING]
> A firmware update is the most dangerous thing in this guide. Use only the image for your card's
> exact **PSID** (OEM cards often need the OEM's image), keep power stable, and read the release
> notes. A failed burn can leave a card that needs recovery procedures. If both hosts already run
> the same, reasonably recent firmware, there is no need to update for these labs.

## 6. Set the port type (VPI adapters only)

VPI adapters run each port as InfiniBand or Ethernet. Query first, then set (1 = InfiniBand,
2 = Ethernet):

```bash
sudo mlxconfig -d /dev/mst/<device> query | grep LINK_TYPE
sudo mlxconfig -d /dev/mst/<device> set LINK_TYPE_P1=2      # Ethernet for RoCE labs
```

The setting is stored in the adapter and survives reboots, but takes effect only after a firmware
reset or a reboot. Ethernet-only adapters have no such parameter. Parameter names vary by adapter
and firmware; trust what `query` shows. Under Secure Boot `mlxconfig` cannot reach the card (see the
note above), so turn Secure Boot off for the change (or use a signed MFT kernel module) and back on
afterwards.

## 7. Configure the data interface

Find the netdev that belongs to your RDMA port:

```bash
rdma link show        # e.g. link rocep59s0f0/1 state ACTIVE physical_state LINK_UP netdev ens1f0np0
```

The first field is the RDMA device name you put in your profile ({{A_RDMA_DEV}}): distribution
rdma-core names devices from the PCI address (`rocep59s0f0`), NVIDIA's stack calls them `mlx5_0`,
`mlx5_1`, ... Use what your host prints.

### Ubuntu (netplan)

Create `/etc/netplan/60-aina-rdma.yaml` (permissions 600):

```yaml
network:
  version: 2
  ethernets:
    {{A_NETDEV}}:
      addresses: [{{A_IP}}/{{PREFIX_LEN}}]
      mtu: {{MTU}}
```

```bash
sudo chmod 600 /etc/netplan/60-aina-rdma.yaml
sudo netplan try          # rolls back automatically unless you confirm
sudo netplan apply
```

No gateway: the data network is a private segment between your hosts (and switch). Keep the
default route on the management interface.

### RHEL family (NetworkManager)

```bash
sudo nmcli connection add type ethernet ifname {{A_NETDEV}} con-name aina-rdma \
  ipv4.method manual ipv4.addresses {{A_IP}}/{{PREFIX_LEN}} 802-3-ethernet.mtu {{MTU}}
sudo nmcli connection up aina-rdma
```

### Verify

```bash
ip -br addr show dev {{A_NETDEV}}
ip link show dev {{A_NETDEV}} | grep -o 'mtu [0-9]*'
ping -M do -s $(({{MTU}} - 28)) -c 3 {{B_IP}}     # once host B is configured too
```

The full-size don't-fragment ping is the real test: it fails if anything on the path has a smaller
MTU. With a switch in between, its ports need an MTU of at least {{MTU}} plus headers (see
[Network and switch setup](#/hw/network-setup)).

## 8. Names and time

Add the data addresses to `/etc/hosts` on every host, so logs and tools show names:

```
{{A_IP}}  {{HOST_A}}-rdma
{{B_IP}}  {{HOST_B}}-rdma
{{C_IP}}  {{HOST_C}}-rdma
```

Keep the plain `{{HOST_A}}` names for the management addresses you SSH to.

Synchronise clocks (chrony is the default on both Ubuntu and RHEL):

```bash
chronyc tracking         # "Leap status : Normal" and a small offset
```

Correlating a PFC storm on the switch with a perftest log on a host is much easier when the
timestamps agree.

## 9. SSH from host A

Check scripts run on host A and start the remote side of each test on hosts B and C over SSH, with
`BatchMode` (no password prompts). On host A, as the user that runs the labs:

```bash
ssh-keygen -t ed25519            # accept the defaults; a passphrase is fine if you use ssh-agent
ssh-copy-id {{SSH_USER}}@{{HOST_B}}
ssh-copy-id {{SSH_USER}}@{{HOST_C}}  # Tier 2 only
ssh -o BatchMode=yes {{SSH_USER}}@{{HOST_B}} true && echo OK
```

### sudo on the remote hosts

The check scripts read state on B and C without root. Steps that **change** a host are run by you,
on that host, with `sudo`. Avoid blanket passwordless sudo. If you want `aina-hw collect-all --sudo`
(it runs the collector with `sudo -n` remotely so that root-only reads such as some QoS queries
succeed), note that a sudoers rule for `python3` is effectively full root; only do this on
dedicated lab machines, and prefer a separate lab user with a rule in its own `/etc/sudoers.d/`
file, edited with `visudo -f`.

## 10. Locked memory

RDMA registers memory and pins it. A low `memlock` limit makes perftest and NCCL fail to register
buffers. A typical default of 8192 KiB is enough for a default perftest run but not for the
all-sizes sweep (`ib_write_bw -a`), which then fails with `Couldn't allocate MR`, `Failed to create
MR` and `Couldn't create IB resources`.

```bash
ulimit -l        # want: unlimited
```

`./setup-rdma-host.sh --set-memlock` writes a limits file; log out and back in. Programs started by
systemd ignore `limits.d` and need `LimitMEMLOCK=infinity` in their unit instead.

## 11. Firewall

The RDMA data path (UDP 4791 for RoCEv2) is handled by the NIC, but connection setup goes through
the host's TCP/IP stack and therefore through its firewall:

| Port | Used by |
|---|---|
| TCP 18515 | `ibv_rc_pingpong` and perftest defaults |
| TCP 18600, 18601 | Lab check scripts (so they do not collide with your own tests) |
| TCP 7174 | `rping` default (RDMA CM) |
| TCP 22 | SSH from host A |
| Varies | MPI and NCCL bootstrap (hw-08): ephemeral TCP ports between the hosts |

On a private data network the simplest rule is to trust the whole data subnet. Replace
`<data-subnet>` with your subnet's network address (for example 192.168.50.0 for the default
profile):

```bash
sudo ufw allow from <data-subnet>/{{PREFIX_LEN}}                                    # Ubuntu with ufw
sudo firewall-cmd --permanent --zone=trusted --add-source=<data-subnet>/{{PREFIX_LEN}}   # RHEL with firewalld
sudo firewall-cmd --reload
```

## 12. First inventory and import

On host A, copy your profile (downloaded from the [Connect page](#/hw/connect)) to
`labs/hw-toolkit/lab.env`, then:

```bash
cd {{AINA_DIR}}/labs
./hw-toolkit/aina-hw env              # shows and validates lab.env
./hw-toolkit/aina-hw collect-all      # inventories every host over SSH (read-only)
```

It writes `labs/hw-toolkit/results/aina-report.json` and prints a short summary. Import that file
on the [Connect page](#/hw/connect) (or start the read-only agent with `aina-hw serve`, see the
[Toolkit guide](#/hw/toolkit)) for the full health review: port state, PCIe width and speed, MTU
and firmware consistency, GIDs, QoS and more.

## Checklist

- [ ] Same OS, kernel and driver stack on every host
- [ ] `setup-rdma-host.sh --check` shows no `[todo]` lines
- [ ] Firmware queried; same version on hosts with the same card
- [ ] Port type correct (VPI cards); RDMA port `ACTIVE` in `rdma link show`
- [ ] Data interface: static IP, MTU {{MTU}}, full-size don't-fragment ping works
- [ ] `/etc/hosts` and chrony in place
- [ ] `ssh -o BatchMode=yes` from host A to B (and C) works
- [ ] `ulimit -l` is unlimited
- [ ] Firewall allows the lab ports on the data network
- [ ] `aina-hw collect-all` report imported and reviewed

Next: [Network and switch setup](#/hw/network-setup), or go straight to
[hw-01](#/hw/labs/hw-01-inventory-baseline) if your hosts are cabled back to back.
