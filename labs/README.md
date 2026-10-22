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

> **Status:** five Tier 0 labs are `verified: true` (see [Verification record](#verification-record)
> below): `hol-linux-net-basics`, `hol-ecmp-entropy`, `hol-ecn-congestion`,
> `hol-clos-bgp-unnumbered` and `hol-evpn-vxlan`. `hol-rocev2-wireshark` (only its synthetic-capture
> path was run) and `hol-soft-roce-perftest` (not run: no `rdma_rxe` in the test kernel) stay
> `verified: false`, as do all `hw-*` labs. Every shell script has been syntax-checked with `bash -n`
> and every YAML file parsed. Please report anything that behaves differently on your system.

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
| `hol-rocev2-wireshark` | Partly run: Option B (synthetic capture, Tasks 2, 5, 7 and `check.sh`) passed; Option A needs two VMs with Soft-RoCE and was not run. Stays `verified: false`. |
| `hol-soft-roce-perftest` | Not runnable here: the WSL2 kernel has no `rdma_rxe` module. Stays `verified: false`. |

**Caveats: WSL2 is not a clean VM.** It runs Microsoft's own kernel build (module set and defaults
differ from Ubuntu's generic kernel; `rdma_rxe` is missing), Docker was already installed, and the
distribution can be shut down when idle or restarted (containerlab containers come back after
that, but without their links, so redeploy in that case). Nothing in the five verified labs relied on WSL-specific
behaviour as far as could be told: both fixes address standard Linux/Docker behaviour that applies
equally to a regular Ubuntu 24.04 VM with Docker installed. A run on a clean Ubuntu 24.04 VM with
the generic kernel is still worthwhile, and is required before the two RDMA labs can be verified.
