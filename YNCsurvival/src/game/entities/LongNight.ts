import { ART_SCALE, artScale, GAME_WIDTH, viewRect } from '../display';
import { DEPTH, FINAL, LIGHT, MOTH, PILGRIM } from '../config';
import { Boss, BossContext } from './Boss';

const SCREEN_BAR_WIDTH = 520;
const EDGE_MARGIN = 20;

//  최종 보스: 긴 밤 (일식)
//  화면 위쪽 하늘에 떠 있는 거대한 검은 원. 땅에 내려오지 않고 하늘에서 전장 전체를 지배한다
//  1페이즈: 부채꼴 장판 / 화면 가장자리 밀랍 탄환 / 운석 5연타
//  2페이즈: 1페이즈 + 중간 보스 2종의 패턴(밀랍 탄막, 재 가루 + 나방 돌진)을 15초마다 번갈아
//  3페이즈: 일식이 갈라지며 꺼져가는 옛 태양의 얼굴이 드러남. 어둠의 손아귀 / 맵 전체 공격(맞으면 0.2초 멈춤)
//          공격할수록 태양이 오히려 밝아지고, 쓰러지면 새벽 엔딩
export class LongNight extends Boss
{
    readonly kind = 'final';
    phase = 1;

    private nextFanAt: number;
    private nextEdgeShotAt: number;
    private nextMeteorAt: number;
    private nextBossPatternAt: number;
    private bossPatternTurn = 0;
    private nextGraspAt = 0;
    private nextNovaAt = 0;
    private meteorQueue: number[] = [];
    private graspQueue: { at: number; angle: number }[] = [];

    private screenBar: Phaser.GameObjects.Graphics;
    private nameText: Phaser.GameObjects.Text;
    private sunGlow?: Phaser.GameObjects.Image;

    constructor (ctx: BossContext, now: number)
    {
        super(ctx, ctx.player.x, ctx.player.y - FINAL.skyOffsetY, 'eclipse', FINAL.hp);
        this.setDepth(DEPTH.sky).setScale(artScale(FINAL.skyScale));
        this.body!.setCircle(90 * ART_SCALE, 30 * ART_SCALE, 30 * ART_SCALE);
        (this.body as Phaser.Physics.Arcade.Body).moves = false;

        this.nextFanAt = now + 2500;
        this.nextEdgeShotAt = now + 1500;
        this.nextMeteorAt = now + 8000;
        this.nextBossPatternAt = now + FINAL.bossPatternIntervalMs;

        const width = GAME_WIDTH;
        this.screenBar = ctx.scene.add.graphics().setScrollFactor(0).setDepth(DEPTH.hud);
        this.nameText = ctx.scene.add.text(width / 2, 62, '', {
            fontFamily: 'Arial Black', fontSize: 18, color: '#ffe2a8', stroke: '#000000', strokeThickness: 4
        }).setOrigin(0.5, 0).setScrollFactor(0).setDepth(DEPTH.hud);

        //  하늘에서 천천히 내려오며 등장
        this.setAlpha(0);
        this.scene.tweens.add({ targets: this, alpha: 1, duration: 2500 });
    }

    update (now: number)
    {
        //  항상 화면 위쪽 가운데 하늘에 머묾 (플레이어 = 화면 중앙)
        (this.body as Phaser.Physics.Arcade.Body).reset(this.ctx.player.x, this.ctx.player.y - FINAL.skyOffsetY);
        this.rotation = this.phase === 3 ? 0 : this.rotation + 0.002;     //  일식만 천천히 회전, 태양 얼굴은 똑바로

        this.updatePhase();

        if (this.phase <= 2)
        {
            this.phaseOnePatterns(now);
        }
        if (this.phase === 2 && now >= this.nextBossPatternAt)
        {
            this.nextBossPatternAt = now + FINAL.bossPatternIntervalMs;
            (this.bossPatternTurn++ % 2 === 0) ? this.waxBarrage() : this.mothPattern();
        }
        if (this.phase === 3)
        {
            this.phaseThreePatterns(now);
            this.brighten();
        }

    }

    render ()
    {
        this.drawScreenBar();
    }

    //  테스트 버튼용: 다음 페이즈 직전까지 체력을 깎음
    skipPhase ()
    {
        const next = this.phase === 1 ? FINAL.phase2At : this.phase === 2 ? FINAL.phase3At : 0.02;
        this.hp = Math.min(this.hp, Math.floor(this.maxHp * next) - 1);
    }

    // ---------------------------------------------------------------- 페이즈 전환

    private updatePhase ()
    {
        const ratio = this.hp / this.maxHp;

        if (this.phase === 1 && ratio <= FINAL.phase2At)
        {
            this.phase = 2;
            this.ctx.announce('밤이 더욱 짙어진다', '#b39ddb');
        }
        if (this.phase === 2 && ratio <= FINAL.phase3At)
        {
            this.phase = 3;
            this.enterPhaseThree();
        }
    }

    private enterPhaseThree ()
    {
        const { scene, hazards, announce } = this.ctx;
        hazards.clear();
        this.meteorQueue = [];
        this.setTexture('sunFace');
        this.restoreTint();

        //  태양 뒤에서 점점 커지는 금빛 후광
        this.sunGlow = scene.add.image(this.x, this.y, 'lanternGlow')
            .setBlendMode(Phaser.BlendModes.ADD).setDepth(DEPTH.sky - 1).setAlpha(0);
        scene.cameras.main.shake(600, 0.01);
        scene.cameras.main.flash(400, 255, 200, 120);
        announce('일식이 갈라진다 — 꺼져가는 옛 태양', '#ffb15c');

        const now = this.nowFrom();
        this.nextGraspAt = now + 2000;
        this.nextNovaAt = now + 5000;
    }

    //  3페이즈: 체력이 줄수록 태양이 밝아지고 어둠이 걷힌다
    private brighten ()
    {
        const lighting = this.ctx.lighting;
        const progress = this.phaseThreeProgress;
        this.scene.tweens.killTweensOf(lighting);
        lighting.darkness = Phaser.Math.Linear(LIGHT.finalDarkness, 0.3, progress);

        this.sunGlow?.setPosition(this.x, this.y).setScale(artScale(2 + progress * 4)).setAlpha(0.4 + progress * 1.2);
        if (!this.tintFill)
        {
            this.restoreTint();     //  피격 번쩍임 중이 아닐 때만 색 갱신
        }
    }

    private get phaseThreeProgress (): number
    {
        return Phaser.Math.Clamp(1 - this.hp / (this.maxHp * FINAL.phase3At), 0, 1);
    }

    protected restoreTint ()
    {
        if (this.phase !== 3)
        {
            this.clearTint();
            return;
        }
        //  어두운 주홍 -> 하얀 빛
        const c = Phaser.Display.Color.Interpolate.ColorWithColor(
            Phaser.Display.Color.ValueToColor(0x6a3424),
            Phaser.Display.Color.ValueToColor(0xffffff),
            100, Math.round(this.phaseThreeProgress * 100)
        );
        this.setTint(Phaser.Display.Color.GetColor(c.r, c.g, c.b));
    }

    // ---------------------------------------------------------------- 1페이즈 (2페이즈에도 반복)

    private phaseOnePatterns (now: number)
    {
        const { player, hazards } = this.ctx;

        //  패턴1: 플레이어를 향한 부채꼴 장판
        if (now >= this.nextFanAt)
        {
            this.nextFanAt = now + FINAL.fanIntervalMs;
            const angle = Phaser.Math.Angle.Between(this.x, this.y, player.x, player.y);
            hazards.addArea({
                shape: 'sector', x: this.x, y: this.y, angle,
                radius: Phaser.Math.Distance.Between(this.x, this.y, player.x, player.y) + 220,
                spread: FINAL.fanSpreadRad, telegraphMs: FINAL.fanTelegraphMs, damage: FINAL.fanDamage,
                color: 0x9b5cff
            });
        }

        //  패턴2: 화면 가장자리 랜덤 위치에서 밀랍 탄환 1~3발
        if (now >= this.nextEdgeShotAt)
        {
            this.nextEdgeShotAt = now + FINAL.edgeShotIntervalMs;
            const count = Phaser.Math.Between(1, 3);
            for (let i = 0; i < count; i++)
            {
                const p = this.randomEdgePoint();
                hazards.fireProjectile(p.x, p.y, Phaser.Math.Angle.Between(p.x, p.y, player.x, player.y), {
                    texture: 'wax', speed: FINAL.edgeShotSpeed, damage: FINAL.edgeShotDamage,
                    slowFactor: PILGRIM.slowFactor, slowMs: FINAL.edgeShotSlowMs
                });
            }
        }

        //  패턴3: 20초마다 플레이어 위치에 운석 5회 (0.2초 간격, 매번 그 순간의 위치를 노림)
        if (now >= this.nextMeteorAt)
        {
            this.nextMeteorAt = now + FINAL.meteorIntervalMs;
            for (let i = 0; i < FINAL.meteorCount; i++)
            {
                this.meteorQueue.push(now + i * FINAL.meteorGapMs);
            }
        }
        while (this.meteorQueue.length > 0 && now >= this.meteorQueue[0])
        {
            this.meteorQueue.shift();
            hazards.addArea({
                shape: 'circle', x: player.x, y: player.y, radius: FINAL.meteorRadius,
                telegraphMs: FINAL.meteorTelegraphMs, damage: FINAL.meteorDamage, color: 0xff7a1a
            });
        }
    }

    // ---------------------------------------------------------------- 2페이즈 추가 패턴

    //  밀랍 순례자의 패턴: 하늘에서 느린 밀랍 탄막
    private waxBarrage ()
    {
        const { player, hazards } = this.ctx;
        const base = Phaser.Math.Angle.Between(this.x, this.y, player.x, player.y);
        for (let i = -4; i <= 4; i++)
        {
            hazards.fireProjectile(this.x, this.y + 60, base + i * 0.2, {
                texture: 'wax', speed: 140, damage: PILGRIM.bulletDamage,
                slowFactor: PILGRIM.slowFactor, slowMs: PILGRIM.slowMs
            });
        }
    }

    //  재의 나방 여왕의 패턴: 재 가루로 빛을 좁히고, 그림자 나방이 화면을 가로질러 돌진
    private mothPattern ()
    {
        const { player, hazards, lighting } = this.ctx;
        lighting.applyAsh(MOTH.ashLightFactor, MOTH.ashMs);

        const angle = Math.random() * Math.PI * 2;
        hazards.addArea({
            shape: 'rect',
            x: player.x - Math.cos(angle) * 700, y: player.y - Math.sin(angle) * 700,
            angle, length: 1400, width: 90,
            telegraphMs: 1000, damage: 25, color: 0xc8c2d0
        });
    }

    // ---------------------------------------------------------------- 3페이즈 (발악)

    private phaseThreePatterns (now: number)
    {
        const { player, hazards, scene } = this.ctx;

        //  패턴1: 어둠의 손아귀 - 경로를 잠깐 보여준 뒤 플레이어를 향해 쏘아짐
        if (now >= this.nextGraspAt)
        {
            this.nextGraspAt = now + FINAL.graspIntervalMs;
            const angle = Phaser.Math.Angle.Between(this.x, this.y, player.x, player.y);
            hazards.addArea({
                shape: 'rect', x: this.x, y: this.y, angle, length: 1200, width: 50,
                telegraphMs: FINAL.graspTelegraphMs, damage: 0, color: 0x9b5cff
            });
            this.graspQueue.push({ at: now + FINAL.graspTelegraphMs, angle });
        }
        while (this.graspQueue.length > 0 && now >= this.graspQueue[0].at)
        {
            const { angle } = this.graspQueue.shift()!;
            hazards.fireProjectile(this.x, this.y, angle, {
                texture: 'darkHand', speed: FINAL.graspSpeed, damage: FINAL.graspDamage, rotate: true
            });
        }

        //  패턴2: 맵 전체 공격 (피할 수 없음). 맞는 순간 0.2초 동안 멈춤
        if (now >= this.nextNovaAt)
        {
            this.nextNovaAt = now + FINAL.novaIntervalMs;
            hazards.addArea({
                shape: 'full', telegraphMs: FINAL.novaTelegraphMs, damage: FINAL.novaDamage,
                stunMs: FINAL.novaStunMs, color: 0x7a3cff,
                onResolve: () => scene.cameras.main.flash(200, 255, 220, 160)
            });
        }
    }

    // ---------------------------------------------------------------- 도우미

    private randomEdgePoint ()
    {
        const view = viewRect(this.scene);
        const side = Phaser.Math.Between(0, 3);
        const t = Math.random();
        switch (side)
        {
            case 0: return { x: view.x + view.width * t, y: view.y + EDGE_MARGIN };
            case 1: return { x: view.right - EDGE_MARGIN, y: view.y + view.height * t };
            case 2: return { x: view.x + view.width * t, y: view.bottom - EDGE_MARGIN };
            default: return { x: view.x + EDGE_MARGIN, y: view.y + view.height * t };
        }
    }

    //  페이즈 전환처럼 update 밖에서 시간이 필요할 때: 다음 공격 시각들 중 가장 이른 값으로 근사
    private nowFrom (): number
    {
        return Math.min(this.nextFanAt, this.nextEdgeShotAt, this.nextMeteorAt) - FINAL.edgeShotIntervalMs;
    }

    private drawScreenBar ()
    {
        const width = GAME_WIDTH;
        const x = (width - SCREEN_BAR_WIDTH) / 2;
        const y = 86;
        const color = this.phase === 3 ? 0xffc04d : 0x7e57c2;

        this.nameText.setText(this.phase === 3 ? '꺼져가는 옛 태양' : `긴 밤 — ${this.phase}페이즈`);
        this.screenBar.clear();
        this.screenBar.fillStyle(0x000000, 0.7).fillRect(x - 2, y - 2, SCREEN_BAR_WIDTH + 4, 16);
        this.screenBar.fillStyle(color).fillRect(x, y, SCREEN_BAR_WIDTH * (this.hp / this.maxHp), 12);
        this.screenBar.lineStyle(1, 0xffe2a8, 0.6).strokeRect(x - 2, y - 2, SCREEN_BAR_WIDTH + 4, 16);
    }

    destroy (fromScene?: boolean)
    {
        this.screenBar?.destroy();
        this.nameText?.destroy();
        this.sunGlow?.destroy();
        super.destroy(fromScene);
    }
}
