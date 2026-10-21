# Hands-on labs: host preparation

These are the supporting files for the AI Networking Academy hands-on labs. The lab instructions
themselves live in `content/labs/handson/<lab-id>.md` (and in the web app); each lab has a matching
directory here with its scripts, topologies and a `check.sh` that prints `PASS:`/`FAIL:` lines and
exits non-zero if any check fails.

> **Status:** all labs are marked `verified: false`. Every shell script has been syntax-checked with
> `bash -n` and every YAML file parsed, but the labs have not yet been executed end to end. Please
> report anything that behaves differently on your system.

## The labs

| Lab | Environment | What you need beyond the base VM |
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
chmod +x setup-ubuntu.sh */*.sh */*.py   # in case your checkout lost the executable bits
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
| `RTNETLINK answers: File exists` in a setup script | A previous run was not cleaned up | Run the lab's `cleanup.sh`, then `setup.sh` again |
| `tc` reports `Specified qdisc kind is unknown` | qdisc module missing | Install `linux-modules-extra-$(uname -r)` |
