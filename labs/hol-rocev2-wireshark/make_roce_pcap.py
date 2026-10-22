#!/usr/bin/env python3
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Copyright (c) 2026 Juraj Liska. AI Networking Academy: noncommercial use only, see LICENSE.
"""Write a small, synthetic RoCEv2 capture for dissection practice.

This is the single-VM fallback for the hol-rocev2-wireshark lab: it builds
Ethernet / IPv4 / UDP(4791) / BTH (+RETH/AETH) / payload / ICRC frames by hand
and writes them to a classic libpcap file. Only the Python standard library is
used.

The packets are realistic in layout but SYNTHETIC: addresses, QPNs, PSNs, keys
and payloads are made up, and the ICRC field is a zero placeholder (it is not
computed). Real captures from two Soft-RoCE VMs are always preferable.

Usage: python3 make_roce_pcap.py [output.pcap]   (default: roce-synthetic.pcap)
"""

import struct
import sys
import time

ROCEV2_UDP_PORT = 4791

# IBTA opcodes (RC unless noted)
SEND_ONLY = 0x04
RDMA_WRITE_FIRST = 0x06
RDMA_WRITE_MIDDLE = 0x07
RDMA_WRITE_LAST = 0x08
RDMA_READ_REQUEST = 0x0C
RDMA_READ_RESPONSE_FIRST = 0x0D
RDMA_READ_RESPONSE_LAST = 0x0F
ACKNOWLEDGE = 0x11
CNP = 0x81  # RoCEv2 Congestion Notification Packet

MAC_A = bytes.fromhex("020000000a01")
MAC_B = bytes.fromhex("020000000a02")
IP_A = bytes([10, 0, 0, 1])
IP_B = bytes([10, 0, 0, 2])
QPN_A = 0x000011  # QP on host A
QPN_B = 0x000012  # QP on host B
SPORT_A = 49290   # RoCEv2 UDP source port chosen by A for this QP (entropy)
SPORT_B = 52011


def ipv4_checksum(header: bytes) -> int:
    total = 0
    for i in range(0, len(header), 2):
        total += (header[i] << 8) + header[i + 1]
    while total >> 16:
        total = (total & 0xFFFF) + (total >> 16)
    return (~total) & 0xFFFF


def bth(opcode, dest_qp, psn, ack_req=False, solicited=False, pad=0, pkey=0xFFFF):
    byte1 = (int(solicited) << 7) | (0 << 6) | ((pad & 0x3) << 4) | 0x0  # SE, MigReq, PadCnt, TVer
    return struct.pack(
        "!BBHB3sB3s",
        opcode,
        byte1,
        pkey,
        0,                                  # reserved (FECN/BECN bits live here in RoCEv2)
        dest_qp.to_bytes(3, "big"),
        (int(ack_req) << 7),                # AckReq + 7 reserved bits
        (psn & 0xFFFFFF).to_bytes(3, "big"),
    )


def reth(va, rkey, dma_len):
    return struct.pack("!QII", va, rkey, dma_len)


def aeth(syndrome, msn):
    return struct.pack("!B3s", syndrome, msn.to_bytes(3, "big"))


def frame(src_mac, dst_mac, src_ip, dst_ip, sport, ib_payload, ecn=0b10, ident=0):
    icrc = b"\x00\x00\x00\x00"              # placeholder, not a valid ICRC
    udp_len = 8 + len(ib_payload) + len(icrc)
    udp = struct.pack("!HHHH", sport, ROCEV2_UDP_PORT, udp_len, 0)  # checksum 0 (allowed for IPv4)
    tos = (0 << 2) | ecn                     # DSCP 0, ECN codepoint (0b10 = ECT(0), 0b11 = CE)
    total_len = 20 + udp_len
    ip_wo_csum = struct.pack(
        "!BBHHHBBH4s4s", 0x45, tos, total_len, ident, 0x4000, 64, 17, 0, src_ip, dst_ip
    )
    csum = ipv4_checksum(ip_wo_csum)
    ip = ip_wo_csum[:10] + struct.pack("!H", csum) + ip_wo_csum[12:]
    eth = dst_mac + src_mac + struct.pack("!H", 0x0800)
    return eth + ip + udp + ib_payload + icrc


def payload(n, fill):
    return bytes([fill]) * n


def build_packets():
    a2b = dict(src_mac=MAC_A, dst_mac=MAC_B, src_ip=IP_A, dst_ip=IP_B, sport=SPORT_A)
    b2a = dict(src_mac=MAC_B, dst_mac=MAC_A, src_ip=IP_B, dst_ip=IP_A, sport=SPORT_B)
    psn_a = 0x100000  # A's send PSN, B's expected PSN
    pkts = []
    ident = 1

    def add(direction, ib, ecn=0b10):
        nonlocal ident
        pkts.append(frame(ib_payload=ib, ecn=ecn, ident=ident, **direction))
        ident += 1

    # 1-2: SEND Only of 64 bytes, then the ACK (AETH syndrome 0x1f = ACK, credits invalid)
    add(a2b, bth(SEND_ONLY, QPN_B, psn_a, ack_req=True, solicited=True) + payload(64, 0x41))
    add(b2a, bth(ACKNOWLEDGE, QPN_A, psn_a) + aeth(0x1F, 1))
    psn_a += 1

    # 3-6: RDMA WRITE of 3000 bytes with a 1024-byte path MTU: FIRST(+RETH) / MIDDLE / LAST, then ACK
    va, rkey = 0x00007F3A12340000, 0x00001234
    add(a2b, bth(RDMA_WRITE_FIRST, QPN_B, psn_a) + reth(va, rkey, 3000) + payload(1024, 0x42))
    add(a2b, bth(RDMA_WRITE_MIDDLE, QPN_B, psn_a + 1) + payload(1024, 0x42), ecn=0b11)  # CE-marked
    add(a2b, bth(RDMA_WRITE_LAST, QPN_B, psn_a + 2, ack_req=True) + payload(952, 0x42))
    add(b2a, bth(ACKNOWLEDGE, QPN_A, psn_a + 2) + aeth(0x1F, 2))
    psn_a += 3

    # 7: the receiver saw a CE mark above, so (with DCQCN) it sends a CNP back to the sender's QP.
    # CNP = BTH with opcode 0x81 + 16 reserved bytes.
    add(b2a, bth(CNP, QPN_A, 0) + bytes(16), ecn=0b00)

    # 8-10: RDMA READ of 2048 bytes: one request (+RETH), two responses (+AETH on FIRST and LAST)
    add(a2b, bth(RDMA_READ_REQUEST, QPN_B, psn_a, ack_req=True) + reth(va + 4096, rkey, 2048))
    add(b2a, bth(RDMA_READ_RESPONSE_FIRST, QPN_A, psn_a) + aeth(0x1F, 3) + payload(1024, 0x43))
    add(b2a, bth(RDMA_READ_RESPONSE_LAST, QPN_A, psn_a + 1) + aeth(0x1F, 3) + payload(1024, 0x43))
    psn_a += 2

    # 11-12: a lost packet. A sends PSN psn_a+1 (psn_a never arrived), B answers with a
    # NAK "PSN sequence error" (syndrome 0x60) carrying the PSN it expected.
    add(a2b, bth(SEND_ONLY, QPN_B, psn_a + 1, ack_req=True) + payload(64, 0x44))
    add(b2a, bth(ACKNOWLEDGE, QPN_A, psn_a) + aeth(0x60, 3))
    return pkts


def write_pcap(path, packets):
    with open(path, "wb") as f:
        f.write(struct.pack("<IHHiIII", 0xA1B2C3D4, 2, 4, 0, 0, 65535, 1))  # LINKTYPE_ETHERNET
        t0 = int(time.time())
        for i, pkt in enumerate(packets):
            ts_sec, ts_usec = t0, i * 10  # 10 us apart
            f.write(struct.pack("<IIII", ts_sec, ts_usec, len(pkt), len(pkt)))
            f.write(pkt)


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "roce-synthetic.pcap"
    packets = build_packets()
    write_pcap(out, packets)
    print(f"Wrote {len(packets)} synthetic RoCEv2 packets to {out}")


if __name__ == "__main__":
    main()
