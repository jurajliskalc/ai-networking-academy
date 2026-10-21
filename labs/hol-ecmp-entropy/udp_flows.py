#!/usr/bin/env python3
"""Send many small UDP "flows" that differ only in their source port.

Each flow is a UDP socket bound to its own source port; it sends --pkts
datagrams to the same destination IP and port. Nothing needs to listen on the
destination: the point is to make the ECMP hash see N different 5-tuples.

Usage (inside the sender namespace):
  sudo ip netns exec ecmp-h1 python3 udp_flows.py --dst 10.5.2.10 --flows 64
"""

import argparse
import socket
import time


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dst", default="10.5.2.10", help="destination IP (default 10.5.2.10)")
    ap.add_argument("--dport", type=int, default=9999, help="destination UDP port (default 9999)")
    ap.add_argument("--flows", type=int, default=16, help="number of flows / source ports (default 16)")
    ap.add_argument("--pkts", type=int, default=100, help="packets per flow (default 100)")
    ap.add_argument("--base-port", type=int, default=20000, help="first source port (default 20000)")
    ap.add_argument("--size", type=int, default=200, help="UDP payload bytes (default 200)")
    args = ap.parse_args()

    payload = b"x" * args.size
    socks = []
    for i in range(args.flows):
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind(("0.0.0.0", args.base_port + i))
        socks.append(s)

    sent = 0
    for _ in range(args.pkts):
        for s in socks:
            # Unconnected sendto: ICMP port-unreachable replies do not raise errors here.
            s.sendto(payload, (args.dst, args.dport))
            sent += 1
        time.sleep(0.001)  # be gentle with the veth queues

    for s in socks:
        s.close()
    print(f"sent {sent} packets in {args.flows} flows "
          f"(src ports {args.base_port}-{args.base_port + args.flows - 1}) to {args.dst}:{args.dport}")


if __name__ == "__main__":
    main()
