# Lab files: Tier 0 VM labs and real-hardware labs

> **Real hardware (Tier 1-3):** labs `hw-*` run on your own RDMA hosts, switch and GPU nodes. Start with
> `hw-toolkit/setup-rdma-host.sh` on every host, generate `hw-toolkit/lab.env` on the app's
> **Real HW labs -> Connect** page, then use `hw-toolkit/aina-hw` (`collect-all`, `check <lab>`, `serve`).
> The app's Real HW section has the full guides (requirements, host and network setup, toolkit, safety,
> troubleshooting). The rest of this page covers the **Tier 0** labs, which need only an Ubuntu VM.

## Tier 0: host preparation

These are the supporting files for the AI Networking Academy hands-on labs. The lab instructions
themselves live in `content/labs/handson/<lab-id>.md` (and in the web app); each lab has a matching
directory here with its scripts, topologies and a `check.sh` that prints `PASS:`/`FAIL:` lines and
exits non-zero if any check fails.

> **Status:** 13 of the 16 hands-on labs are `verified: true` (see [Verification record](#verification-record)
> and [Hardware verification record](#hardware-verification-record) below): all seven Tier 0 labs (five on
> WSL2, `hol-soft-roce-perftest` and `hol-rocev2-wireshark` on the hardware lab hosts) and the Tier 1 labs
> `hw-01` to `hw-05` and `hw-09` on real ConnectX-5 hardware. `hw-06` (needs a lossless switch) and
> `hw-07`/`hw-08` (need GPU nodes) stay `verified: false`. Every shell script has been syntax-checked with
> `bash -n` and every YAML file parsed. Please report anything that behaves differently on your system.

## The labs

| Tier 0 lab | Environment | What you need beyond the base VM |
|---|---|---|
| `hol-linux-net-basics` | linux-vm | nothing |
| `hol-soft-roce-perftest` | linux-vm | `rdma_rxe` kernel module, rdma-core, perftest |
| `hol-rocev2-wireshark` | linux-vm | **two VMs** for a real capture (or the synthetic capture generator on one VM), tshark |
| `hol-clos-bgp-unnumbered` | containerlab | Docker, containerlab, internet access to pull FRR and Alpine images |
| `hol-ecmp-entropy` | linux-vm | iperf3, python3 |
| `hol-ecn-congestion` | linux-vm | iperf3, `tcp_dctcp` and qdisc kernel modules |
| `hol-evpn-vxlan` | containerlab | Docker, containerlab, `vxlan` kernel module |

## The VM

- **Ubuntu 24.04 LTS** (server or desktop), x86_64. Other recent distributions work with different
  package names.
- **4 vCPU, 8 GB RAM, 20 GB free disk** (the containerlab labs are the heaviest; the others run
  with 2 vCPU and 4 GB).
- A NIC with an IPv4 address (the hypervisor's NAT network is fine).
- Prefer the **generic** Ubuntu kernel: cloud-provider kernels (`-aws`, `-azure`, `-gcp`, ...) can
  package or omit modules such as `rdma_rxe` and `sch_netem` differently.
- Run the labs on a VM you can throw away: they create namespaces, load kernel modules and change
  sysctls (inside namespaces wherever possible).

For `hol-rocev2-wireshark` you need a second, similar VM on the same virtual network, so that
Soft-RoCE packets actually cross a network interface. Two 2 vCPU / 2 GB VMs are enough.

## Quick setup

```bash
git clone <this repository> && cd <repository>/labs
chmod +x setup-ubuntu.sh */*.sh */*.py hw-toolkit/aina-hw   # in case your checkout lost the executable bits
./setup-ubuntu.sh            # uses sudo; options: --no-containerlab --no-rdma --no-docker
# log out and back in if the script added you to the docker group
```

`setup-ubuntu.sh` is idempotent and prints every command it runs. It:

1. Pre-answers two package questions (no setuid `dumpcap` for Wireshark, no iperf3 daemon at boot).
2. Installs the base tools: `iproute2 iputils-ping traceroute ethtool tcpdump tshark iperf3 jq
   python3 curl ca-certificates kmod`.
3. Installs `linux-modules-extra-$(uname -r)` if it exists for your kernel (it contains, among
   others, the Soft-RoCE driver on Ubuntu generic kernels).
4. Installs the RDMA user space: `rdma-core ibverbs-utils ibverbs-providers perftest rdmacm-utils`.
5. Installs Docker (`docker.io` from the Ubuntu archive) if no `docker` command exists, enables the
   service and adds you to the `docker` group.
6. Installs containerlab with the official installer if it is not already installed.
7. Reports whether the kernel modules the labs use are available.

## Manual setup

If you prefer to do it by hand:

```bash
sudo apt-get update
sudo apt-get install -y iproute2 iputils-ping traceroute ethtool tcpdump tshark iperf3 jq python3 curl
sudo apt-get install -y linux-modules-extra-$(uname -r)
sudo apt-get install -y rdma-core ibverbs-utils ibverbs-providers perftest rdmacm-utils

# Docker: either Ubuntu's package...
sudo apt-get install -y docker.io && sudo systemctl enable --now docker
# ...or Docker CE following https://docs.docker.com/engine/install/ubuntu/
sudo usermod -aG docker $USER     # then log out and back in

# containerlab: official installer (see https://containerlab.dev/install/ for alternatives,
# including a "quick setup" script that also installs Docker)
bash -c "$(curl -sL https://get.containerlab.dev)"
containerlab version
```

Check the kernel side:

```bash
sudo modprobe rdma_rxe && lsmod | grep rdma_rxe     # Soft-RoCE
sudo modprobe tcp_dctcp && sysctl net.ipv4.tcp_available_congestion_control
```

## Conventions used by every lab

- Run lab commands from the lab's directory (`cd labs/<lab-id>`). Scripts that change the system
  must run as root (`sudo ./script.sh`); they say so if you forget.
- Every lab has a **clean-up** step (`cleanup.sh` or `containerlab destroy ... --cleanup`). Run it
  before starting a different lab: some labs reuse address ranges.
- `check.sh` verifies the end state of the lab. It never needs internet access. Some checks run a
  short test (for example a few seconds of iperf3 or perftest) and restore any setting they change.
- Command output in the lab text is **illustrative**: versions, MAC addresses, counters and timings
  will differ on your machine.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `modprobe: FATAL: Module rdma_rxe not found` | Extra modules not installed, or a cloud kernel without it | `sudo apt-get install linux-modules-extra-$(uname -r)`, or boot the generic kernel |
| `permission denied ... docker.sock` | Not in the docker group yet | Log out and back in, or use `sudo` |
| containerlab cannot pull `quay.io/frrouting/frr:<tag>` | Tag removed or no internet access | Pick another released tag on quay.io and edit the lab's `topology.clab.yml` |
| BGP sessions in a containerlab lab stay in `Active`/`Idle` | IPv6 disabled in the containers, so no link-local addresses for BGP unnumbered | Check `ip -6 addr` inside the node; the topology's `exec` lines re-enable IPv6, check `docker logs` for errors |
| Pings across a Linux bridge fail although ARP resolves (`hol-linux-net-basics`) | Docker loaded `br_netfilter` and set the iptables `FORWARD` policy to `DROP`, which also filters bridged IPv4 | `sudo iptables -I FORWARD -i br-hol1 -o br-hol1 -j ACCEPT` (the lab's `setup.sh` does this, `cleanup.sh` removes it) |
| `sysctl: setting key "net.ipv4.tcp_congestion_control": Operation not permitted` inside a namespace | Non-initial namespaces may only select algorithms in the host-wide `net.ipv4.tcp_allowed_congestion_control` | Add it there (the `hol-ecn-congestion` `setup.sh` adds `dctcp`, `cleanup.sh` restores the list) |
| `RTNETLINK answers: File exists` in a setup script | A previous run was not cleaned up | Run the lab's `cleanup.sh`, then `setup.sh` again |
| `tc` reports `Specified qdisc kind is unknown` | qdisc module missing | Install `linux-modules-extra-$(uname -r)` |

## Verification record

Run on **2026-10-22** by following each lab's instructions literally (every command block of every
task, then `check.sh` and the clean-up step, confirming afterwards that no namespaces, containers,
links, iptables rules or sysctl changes were left behind).

| Component | Version |
|---|---|
| Host | Windows 10 Pro 22H2 with WSL 2.6.1.0, 32 vCPU, 30 GB RAM |
| Distribution | Ubuntu 24.04.4 LTS (WSL2 distribution, systemd enabled) |
| Kernel | `6.6.87.2-microsoft-standard-WSL2` (Microsoft's WSL2 kernel, not Ubuntu's generic kernel) |
| Docker | 29.1.3 (`docker.io` 29.1.3-0ubuntu3~24.04.2) |
| containerlab | 0.81.1 (installed by `setup-ubuntu.sh` from get.containerlab.dev) |
| FRR | 10.2.1 (`quay.io/frrouting/frr:10.2.1`), hosts `alpine:3.20` |
| Tools | iproute2 6.1.0, iperf 3.16, tcpdump 4.99.4, ethtool 6.7, TShark 4.2.2, Python 3.12.3 |

| Lab | Result |
|---|---|
| `setup-ubuntu.sh` | Ran to completion (`linux-modules-extra` does not exist for the WSL2 kernel; the script reports that and continues). |
| `hol-linux-net-basics` | Passed after a fix: Docker's `FORWARD DROP` policy blocked bridged traffic (see Troubleshooting). |
| `hol-ecmp-entropy` | Passed unchanged. |
| `hol-ecn-congestion` | Passed after a fix: `dctcp` had to be added to `net.ipv4.tcp_allowed_congestion_control`. |
| `hol-clos-bgp-unnumbered` | Passed (text corrections only). |
| `hol-evpn-vxlan` | Passed (text corrections only). |
| `hol-rocev2-wireshark` | Option B passed here; Option A was verified later on the hardware lab hosts (see below). |
| `hol-soft-roce-perftest` | Not runnable here (no `rdma_rxe` in the WSL2 kernel); verified later on the hardware lab hosts (see below). |

**Caveats: WSL2 is not a clean VM.** It runs Microsoft's own kernel build (module set and defaults
differ from Ubuntu's generic kernel; `rdma_rxe` is missing), Docker was already installed, and the
distribution can be shut down when idle or restarted (containerlab containers come back after
that, but without their links, so redeploy in that case). Nothing in the five verified labs relied on WSL-specific
behaviour as far as could be told: both fixes address standard Linux/Docker behaviour that applies
equally to a regular Ubuntu 24.04 VM with Docker installed. A run on a clean Ubuntu 24.04 VM with
the generic kernel is still worthwhile, and is required before the two RDMA labs can be verified.

## Hardware verification record

Run on **2026-10-23** on two hosts cabled back to back, following each lab's instructions literally
(every command block of every task with the lab profile's values filled in, host B commands in a second
session, then `aina-hw check` and the restore step; QoS, global pause and rdma_cm state confirmed back at
their original values afterwards). The commands and sample output of every lab, lesson and the command
reference were also compared with this hardware on both driver stacks: see
[docs/HARDWARE_VERIFICATION.md](../docs/HARDWARE_VERIFICATION.md).

| Component | Version |
|---|---|
| Hosts | 2x Dell PowerEdge R640, ESXi VMs with PCI passthrough of the NIC |
| NIC | ConnectX-5 VPI MCX556A-ECA (dual-port, EDR IB / 100GbE), Ethernet mode, firmware 16.29.1016 (A) and 16.34.1002 (B) |
| Cabling | 1 m passive DAC (MCP1600-E00AE30) port 1 to port 1, port 2 to port 2; no switch |
| OS | Ubuntu 26.04.1 LTS, kernel 7.0.0-38-generic; Secure Boot on for the format checks, off for MFT checks |
| Driver stack | NVIDIA DOCA-OFED 3.4.0 (`OFED-internal-26.04-0.8.6`; Canonical-signed `linux-modules-doca-ofed-3.4`), rdma-core 2604.0.7, perftest 26.04.16, mlnx-tools 2604.0.13, MFT 4.36/4.37. Format checks also on the inbox stack (rdma-core 61.0, perftest 25.01) |
| Tools | iproute2 6.19, ethtool 6.19, Python 3 (Ubuntu 26.04) |

| Lab | Result |
|---|---|
| `setup-rdma-host.sh` | Ran clean on both hosts; `--set-memlock` fixed the 8192 KiB default. |
| `aina-hw collect-all` | Passed after a fix: host A was treated as remote when `HOST_A` was a data-network name or IP. |
| `hw-01-inventory-baseline` | Passed (warning for the mixed firmware, as designed). Inside a VM the PCIe values describe the virtual root port. |
| `hw-02-roce-first-traffic` | Passed: 95-98 Gb/s RDMA write, 181 Gb/s bidirectional, 0.87 us minimum write latency. Text refined: path MTU effect measured per message size. |
| `hw-03-host-qos-pfc-ecn` | Passed after fixes: `restore-qos.sh` now also restores 802.3x global pause (enabling PFC had switched it off) and the rdma_cm default ToS; `apply-qos.sh` shows the global pause state. |
| `hw-04-break-fix-roce` | Passed: every fault injected, diagnosed and restored, and one random fault diagnosed from the lab's commands alone. Fixed: `trust-pcp` on the inbox stack; checks now say when host B is unreachable rather than suggesting `ssh-copy-id`; `HOST_*` must be management addresses (the data-path faults cut the checks off otherwise). |
| `hw-05-link-health-optics` | Passed after a fix: the module check now uses `sudo -n ethtool -m` and matches tab-indented fields. |
| `hw-09-infiniband-bringup` | Passed after fixes (port 2 of both cards in InfiniBand mode, back to back, DOCA OpenSM): the umad tools opened the first RDMA device (the RoCE port) and failed, so `start-sm.sh`, the check and the lab commands now name the device and port (`-C`/`-P`); `start-sm.sh` binds OpenSM to the lab port's GUID. 97 Gb/s over IB, SM loss leaves ports ACTIVE as the lab says. In a VM the port-type change needed a physical host reboot. |
| `hol-soft-roce-perftest` | Passed unchanged (Ubuntu 24.04 user space in a container on host A, Soft-RoCE on its VMXNET3 interface, generic kernel with the distribution's RDMA stack). Notes added: `linux-modules-extra` does not exist for newer kernels; Soft-RoCE cannot work next to NVIDIA's DOCA/OFED, whose `ib_core` the stock `rdma_rxe` refuses (`disagrees about version of symbol`). |
| `hol-rocev2-wireshark` | Option A passed after two fixes (one container per host, Soft-RoCE on the shared 1500-byte segment): on Ubuntu 26.04 the `tshark` AppArmor profile only reads `/tmp` files you own, so captures now use `tcpdump -Z $USER`; `check.sh` demanded an RC ACKNOWLEDGE in the READ capture, where the READ responses carry the acknowledgement. |

**Caveats:** one NIC model, back to back, inside VMs, and the DOCA stack for the lab runs. The inbox-stack
paths of the labs (`dcb` instead of `mlnx_qos`) were exercised command by command but not run end to end.
