import { FINAL, MOTH, PILGRIM } from '../config';
import { AshMothQueen } from '../entities/AshMothQueen';
import { Boss, BossContext, BossKind } from '../entities/Boss';
import { LongNight } from '../entities/LongNight';
import { Player } from '../entities/Player';
import { WaxPilgrim } from '../entities/WaxPilgrim';
import { pointAroundPlayer } from '../utils/spawn';
import { Lighting } from '../world/Lighting';
import { Hazards } from './Hazards';

export interface BossHandlers
{
    onBossSpawned: (boss: Boss) => void;
    onBossKilled: (boss: Boss) => void;
    announce: (message: string, color: string) => void;
}

//  보스 생성(자동 주기 / 버튼 / 후원) / 갱신 / 처치 처리
//  - 밀랍 순례자: 2분 30초마다 자동 등장 (최종 보스 등장 전까지)
//  - 재의 나방 여왕: 후원 전용. spawnMothQueen(후원 금액, 후원자) 로만 등장
//  - 긴 밤: 10분에 자동 등장, 등장하면 다른 보스와 짐승은 모두 사라짐
export class BossManager
{
    readonly group: Phaser.Physics.Arcade.Group;
    private nextPilgrimAt = PILGRIM.spawnIntervalMs;
    private finalAutoSpawned = false;
    private now = 0;
    private ctx: BossContext;

    constructor (scene: Phaser.Scene, private player: Player, hazards: Hazards, lighting: Lighting, private handlers: BossHandlers)
    {
        this.group = scene.physics.add.group();
        this.ctx = { scene, player, hazards, lighting, announce: handlers.announce };
    }

    //  now: 게임 경과 시간(ms)
    update (now: number)
    {
        this.now = now;

        if (now >= this.nextPilgrimAt && now < FINAL.spawnAtMs)
        {
            this.spawnPilgrim();
        }
        while (now >= this.nextPilgrimAt)
        {
            this.nextPilgrimAt += PILGRIM.spawnIntervalMs;    //  밀린 주기가 있어도 한 마리만
        }

        if (!this.finalAutoSpawned && now >= FINAL.spawnAtMs)
        {
            this.finalAutoSpawned = true;
            this.spawnFinal();
        }

        for (const boss of this.activeBosses())
        {
            boss.update(now);
        }
    }

    get finalBoss (): LongNight | undefined
    {
        return this.activeBosses().find((b) => b.kind === 'final') as LongNight | undefined;
    }

    //  생성되면 보스를, 조건(최대 수, 최종 보스 진행 중)에 걸리면 null 을 돌려준다
    spawnPilgrim (): Boss | null
    {
        if (this.finalBoss || this.count('pilgrim') >= PILGRIM.maxAlive)
        {
            return null;
        }
        const { x, y } = pointAroundPlayer(this.ctx.scene, this.player, 60);
        return this.add(new WaxPilgrim(this.ctx, x, y, this.now));
    }

    //  후원 전용. 금액이 클수록 체력과 피해량 증가
    spawnMothQueen (donation: number, donor?: string): Boss | null
    {
        if (this.finalBoss || this.count('moth') >= MOTH.maxAlive)
        {
            return null;
        }
        const { x, y } = pointAroundPlayer(this.ctx.scene, this.player, 60);
        return this.add(new AshMothQueen(this.ctx, x, y, this.now, donation, donor));
    }

    spawnFinal (): Boss | null
    {
        if (this.finalBoss)
        {
            return null;
        }
        //  긴 밤이 오면 다른 보스는 보상 없이 사라짐
        for (const boss of this.activeBosses())
        {
            this.group.remove(boss, true, true);
        }
        return this.add(new LongNight(this.ctx, this.now));
    }

    damage (boss: Boss, amount: number)
    {
        if (!boss.active)
        {
            return;
        }

        if (boss.takeDamage(amount))
        {
            this.group.remove(boss, true, true);
            this.handlers.onBossKilled(boss);   //  destroy 후에도 x, y, kind 값은 남아 있음
        }
    }

    activeBosses (): Boss[]
    {
        return this.group.getChildren().filter((b) => b.active) as Boss[];
    }

    private count (kind: BossKind): number
    {
        return this.activeBosses().filter((b) => b.kind === kind).length;
    }

    private add (boss: Boss): Boss
    {
        this.group.add(boss);
        this.handlers.onBossSpawned(boss);
        return boss;
    }
}
