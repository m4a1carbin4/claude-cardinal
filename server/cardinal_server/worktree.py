"""git worktree 만들기/치우기: 워커 세션이 저장소를 직접 건드리지 않고 자기 브랜치·폴더에서 일하게.

session_new_worktree 도구가 씀. cwd 가 git 저장소일 때만 지원.
"""

import asyncio
import os
import re
from dataclasses import dataclass
from pathlib import Path


class WorktreeError(Exception):
    pass


@dataclass
class Worktree:
    path: str  # 만든 worktree 루트
    cwd: str  # 세션이 열 폴더 (요청 cwd 가 저장소 하위 폴더였으면 worktree 안의 같은 하위 폴더)
    branch: str
    repo: str  # 원본 저장소 루트
    new_branch: bool  # 이번에 브랜치를 새로 만들었는지 (실패 시 같이 지움)


async def _git(cwd: str, *args: str) -> str:
    proc = await asyncio.create_subprocess_exec(
        "git", "-C", cwd, *args,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        env={**os.environ, "GIT_TERMINAL_PROMPT": "0"})
    out, err = await proc.communicate()
    if proc.returncode != 0:
        raise WorktreeError((err.decode(errors="replace").strip() or out.decode(errors="replace").strip()
                             or f"git {args[0]} 실패"))
    return out.decode(errors="replace").strip()


def _safe(s: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "-", s).strip("-") or "repo"


async def create(*, cwd: str, name: str, base_dir: Path, branch: str | None = None, base: str | None = None,
                 dir: str | None = None) -> Worktree:
    """cwd 가 속한 저장소에 worktree 를 만듦.

    base_dir: dir 을 안 주면 <base_dir>/<저장소>-<name> 에 만듦 (카디널 워크스페이스)
    dir: 직접 정한 worktree 경로 (절대 경로, 아직 없어야 함)
    branch: 안 주면 세션 이름. 이미 있는 브랜치면 그걸 체크아웃, 없으면 base(기본 HEAD)에서 새로 만듦
    """
    if not Path(cwd).is_dir():
        raise WorktreeError(f"작업 폴더가 없음: {cwd}")
    try:
        top = os.path.realpath(await _git(cwd, "rev-parse", "--show-toplevel"))
    except WorktreeError:
        raise WorktreeError(f"git 저장소가 아님: {cwd} (worktree 는 git 저장소에서만)")
    common = os.path.realpath(await _git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"))
    # 링크된 worktree 에서 불러도 원본 저장소 이름을 씀
    repo_root = os.path.dirname(common) if os.path.basename(common) == ".git" else top
    rel = os.path.relpath(os.path.realpath(cwd), top)

    branch = branch or name
    try:
        await _git(top, "check-ref-format", "--branch", branch)
    except WorktreeError:
        raise WorktreeError(f"브랜치 이름이 올바르지 않음: {branch}")

    if dir:
        if not os.path.isabs(dir):
            raise WorktreeError(f"worktree 경로는 절대 경로여야 함: {dir}")
        path = os.path.abspath(dir)
    else:
        path = os.path.join(os.path.realpath(base_dir), f"{_safe(os.path.basename(repo_root))}-{_safe(name)}")
    if os.path.lexists(path):
        raise WorktreeError(f"이미 있는 경로: {path}")
    os.makedirs(os.path.dirname(path), exist_ok=True)

    exists = True
    try:
        await _git(top, "show-ref", "--verify", "--quiet", f"refs/heads/{branch}")
    except WorktreeError:
        exists = False
    if exists:
        if base:
            raise WorktreeError(f"이미 있는 브랜치라 base 를 줄 수 없음: {branch}")
        await _git(top, "worktree", "add", path, branch)
    else:
        await _git(top, "worktree", "add", "-b", branch, path, *([base] if base else []))
    # 하위 폴더에서 불렀으면 worktree 안 같은 하위 폴더로
    sub = os.path.join(path, rel) if rel != "." else path
    return Worktree(path=path, cwd=sub if os.path.isdir(sub) else path, branch=branch, repo=top, new_branch=not exists)


async def remove(wt: Worktree) -> None:
    """create 직후 세션 만들기가 실패했을 때 되돌리기 (손실 없는 새 worktree 만)"""
    try:
        await _git(wt.repo, "worktree", "remove", "--force", wt.path)
        if wt.new_branch:
            await _git(wt.repo, "branch", "-D", wt.branch)
    except WorktreeError:
        pass
