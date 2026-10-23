#!/usr/bin/env bash
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Copyright (c) 2026 Juraj Liska. AI Networking Academy: noncommercial use only, see LICENSE.
# hw-14-mpi-ucx-rdma: download, verify and build the OSU Micro-Benchmarks against the installed MPI.
# Run as your normal user on EVERY host (mpirun starts the same path on all of them):
#   ./build-osu.sh            installs into ~/osu (binaries under ~/osu/libexec/osu-micro-benchmarks/mpi)
#   OSU_PREFIX=/opt/osu ./build-osu.sh
# Needs mpicc (Open MPI development package), make, curl and internet access to mvapich.cse.ohio-state.edu.
set -euo pipefail
VER=7.5.2
SHA256=618de3d0b1122f73a9229177d2da1e5cd62e431190580cb915f2605849cbbbdc
URL=https://mvapich.cse.ohio-state.edu/download/mvapich/osu-micro-benchmarks-$VER.tar.gz
PREFIX=${OSU_PREFIX:-$HOME/osu}
BUILD=${OSU_BUILD:-$HOME/osu-build}

for t in mpicc mpicxx make curl sha256sum; do
  command -v "$t" >/dev/null 2>&1 || { echo "FAIL: $t is missing (see the lab's Before you start: openmpi-bin libopenmpi-dev, build-essential)"; exit 1; }
done
if [[ -x "$PREFIX/libexec/osu-micro-benchmarks/mpi/pt2pt/osu_bw" ]]; then
  echo "OSU Micro-Benchmarks already installed in $PREFIX; delete it to rebuild."
  exit 0
fi
mkdir -p "$BUILD"
cd "$BUILD"
[[ -f osu-micro-benchmarks-$VER.tar.gz ]] || { echo "+ curl -fsSLO $URL"; curl -fsSLO "$URL"; }
echo "$SHA256  osu-micro-benchmarks-$VER.tar.gz" | sha256sum -c -
rm -rf "osu-micro-benchmarks-$VER"
tar xzf "osu-micro-benchmarks-$VER.tar.gz"
cd "osu-micro-benchmarks-$VER"
echo "+ ./configure CC=mpicc CXX=mpicxx --prefix=$PREFIX"
./configure CC=mpicc CXX=mpicxx --prefix="$PREFIX" >configure.log 2>&1 || { tail -20 configure.log; exit 1; }
echo "+ make -j$(nproc) && make install"
make -j"$(nproc)" >make.log 2>&1 || { tail -20 make.log; exit 1; }
make install >install.log 2>&1
ls "$PREFIX/libexec/osu-micro-benchmarks/mpi/pt2pt/osu_bw" "$PREFIX/libexec/osu-micro-benchmarks/mpi/collective/osu_allreduce"
echo "Installed OSU Micro-Benchmarks $VER into $PREFIX"
