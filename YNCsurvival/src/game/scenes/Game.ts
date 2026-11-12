import { Scene } from 'phaser';
import { PALETTE } from '../art/Textures';
import { DEPTH, FALLBACK_HEAL, LIGHT, MOTH, SHOW_DEBUG_BUTTONS } from '../config';
import { PASSIVE_IDS, PASSIVES } from '../data/passives';
import { WeaponId } from '../data/weapons';
import { Boss } from '../entities/Boss';
import { Player } from '../entities/Player';
import { BossManager } from '../systems/BossManager';
import { EnemySpawner } from '../systems/EnemySpawner';
import { Experience } from '../systems/Experience';
import { Hazards, HitEffects } from '../systems/Hazards';
import { PlayerStats } from '../systems/PlayerStats';
import { Targets } from '../systems/Targets';
import { rollUpgradeChoices, UpgradeChoice } from '../systems/Upgrades';
import { createDebugButtons } from '../ui/DebugButtons';
import { Hud } from '../ui/Hud';
import { EmberPool } from '../weapons/EmberPool';
import { EmberShot } from '../weapons/EmberShot';
import { LanternAura } from '../weapons/LanternAura';
import { Weapon, WeaponContext } from '../weapons/Weapon';
import { InfiniteBackground } from '../world/InfiniteBackground';
import { Lighting } from '../world/Lighting';
import { LevelUpData } from './LevelUp';
import { AudienceEvent, getStreamDirector, StreamDirectorClient } from '../net/StreamDirectorClient';
import { AudienceEvents } from '../systems/AudienceEvents';
import type { ChatOverlay } from './ChatOverlay';

const PLAYER_NICKNAME = '등불지기';
const STATE_REPORT_MS = 2000;       //  AI 서버로 게임 상태를 보내는 주기 (LLM 상황 판단용)
const PROGRESS_RECORD_MS = 60_000;  //  플레이 기록(DB) 중간 저장 주기
const SAVE_SLOT = 0;

//  서버 DB 에 저장되는 세이브: 기록 요약
interface LanternSave
{
    plays: number;
    clears: number;
    bestSurvivedMs: number;
    bestKills: number;
    bestLevel: number;
    lastPlayedAt: string;
}

export interface GameResult
{
    survivedMs: number;
    kills: number;
    level: number;
    cleared: boolean;   //  긴 밤(최종 보스) 처치 여부
}

const DAWN_MS = 2500;

//  「마지막 등불」 게임 본체: 각 시스템을 만들고 연결하는 역할만 한다
//  세부 동작은 art / world / entities / systems / weapons / ui 폴더 참고
export class Game extends Scene
{
    background: InfiniteBackground;
    lighting: Lighting;
    stats: PlayerStats;
    player: Player;
    enemies: EnemySpawner;
    hazards: Hazards;
    bosses: BossManager;
    targets: Targets;
    experience: Experience;
    weapons: Weapon[];
    hud: Hud;
    ai: StreamDirectorClient;
    audience: AudienceEvents;
    pendingAudience: AudienceEvent[];
    save: { data: LanternSave; version: number } | null;

    cursors: Phaser.Types.Input.Keyboard.CursorKeys;
    wasd: Record<'up' | 'down' | 'left' | 'right', Phaser.Input.Keyboard.Key>;

    //  씬 재시작 시에도 초기화되도록 create()에서 값을 넣는다
    kills: number;
    elapsedMs: number;
    pendingLevelUps: number;
    isGameOver: boolean;

    constructor ()
    {
        super('Game');
    }

    create ()
    {
        this.kills = 0;
        this.elapsedMs = 0;
        this.pendingLevelUps = 0;
        this.isGameOver = false;

        //  끝없이 이어지는 밤의 대지 (배경 이미지 몇 장을 재배치해서 재사용)
        this.cameras.main.setBackgroundColor(PALETTE.night);
        this.background = new InfiniteBackground(this);

        //  등불지기
        this.stats = new PlayerStats();
        this.player = new Player(this, 0, 0, this.stats);
        this.cameras.main.startFollow(this.player, true);
        this.lighting = new Lighting(this);

        //  그을린 짐승 / 경험치 불씨
        this.enemies = new EnemySpawner(this, this.player, (x, y, xp) => {
            this.kills++;
            this.experience.dropGem(x, y, xp);
        });
        this.experience = new Experience(this, this.player, () => this.onLevelUp());

        //  보스 (밀랍 순례자 / 재의 나방 여왕 / 긴 밤) 와 보스 공격
        this.hazards = new Hazards(this, this.player, (damage, effects) => this.onPlayerHit(damage, effects));
        this.bosses = new BossManager(this, this.player, this.hazards, this.lighting, {
            onBossSpawned: (boss) => this.onBossSpawned(boss),
            onBossKilled: (boss) => this.onBossKilled(boss),
            announce: (message, color) => this.announce(message, color)
        });
        this.targets = new Targets(this.enemies, this.bosses);

        //  무기 (시작 무기: 불씨 탄)
        this.weapons = [this.createWeapon('emberShot')];

        //  짐승 / 보스와 닿으면 피해
        this.physics.add.overlap(this.player, this.enemies.group, (_player, enemy) => {
            this.onPlayerHit(this.enemies.contactDamage(enemy as Phaser.Physics.Arcade.Sprite));
        });
        this.physics.add.overlap(this.player, this.bosses.group, (_player, boss) => {
            this.onPlayerHit((boss as Boss).contactDamage);
        });

        //  입력 (방향키 + WASD)
        const keyboard = this.input.keyboard!;
        this.cursors = keyboard.createCursorKeys();
        this.wasd = keyboard.addKeys({ up: 'W', down: 'S', left: 'A', right: 'D' }) as Game['wasd'];

        this.hud = new Hud(this);
        this.updateWorld();
        this.updateHud();

        if (SHOW_DEBUG_BUTTONS)
        {
            createDebugButtons(this, [
                { label: '밀랍 순례자 소환', onClick: () => this.bosses.spawnPilgrim() ?? this.announce('지금은 소환할 수 없음', '#b0bec5') },
                { label: '나방 여왕 (후원 5천원)', onClick: () => this.onDonation(5_000, '테스트') },
                { label: '나방 여왕 (후원 5만원)', onClick: () => this.onDonation(50_000, '테스트') },
                { label: '긴 밤 소환', onClick: () => this.bosses.spawnFinal() ?? this.announce('긴 밤이 이미 와 있음', '#b0bec5') },
                { label: '긴 밤 다음 페이즈', onClick: () => this.bosses.finalBoss?.skipPhase() },
                //  AI 서버 연동 테스트: 가짜 시청자 채팅을 서버로 보냄 (검열 -> AI -> 이벤트 경로를 그대로 거침)
                { label: 'AI: 채팅 "몹 더 보내"', onClick: () => this.simulateChat(['몹 더 보내줘', '몬스터 많이 보내', '좀비 소환 ㄱㄱ', '시발 노잼']) },
                { label: 'AI: 채팅 "아이템 줘"', onClick: () => this.simulateChat(['보급 상자 줘', '아이템 드랍 해줘', '선물 주자']) },
                { label: 'AI: 후원 1만원 "보스"', onClick: () => this.simulateDonation(10_000, '보스 소환해줘') }
            ]);
        }

        this.announce('마지막 등불이 꺼지기 전에', '#ffd27a');
        this.connectAudience();
    }

    // ---------------------------------------------------------------- 시청자 참여 (StreamDirector AI 서버, MCP)

    connectAudience ()
    {
        this.audience = new AudienceEvents(this);
        this.pendingAudience = [];
        this.save = null;

        this.ai = getStreamDirector((connected) => {
            const overlay = this.scene.get('ChatOverlay') as ChatOverlay | null;
            overlay?.addLine(connected ? '[시스템] AI 서버 연결됨' : '[시스템] AI 서버 연결 끊김 - 재연결 시도 중',
                connected ? '#81c784' : '#e57373');
        });
        //  레벨업 화면 등으로 씬이 멈춰 있을 때 온 이벤트는 모아 뒀다가 다시 진행될 때 적용
        this.ai.startEvents((event) => this.pendingAudience.push(event));
        void this.ai.startSession(PLAYER_NICKNAME);
        void this.ai.load<LanternSave>(SAVE_SLOT).then((save) => { this.save = save; });

        this.time.addEvent({ delay: STATE_REPORT_MS, loop: true, callback: () => this.reportState() });
        this.time.addEvent({
            delay: PROGRESS_RECORD_MS, loop: true,
            callback: () => void this.ai.recordProgress(this.wave, this.player.hp, this.experience.level,
                this.kills, this.kills, this.audience.applied)
        });
        this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.audience.destroy());
    }

    simulateChat (texts: string[])
    {
        const stamp = Date.now();
        const messages = texts.map((text, i) => ({
            user_id: `test-viewer-${stamp}-${i}`, nickname: `테스트시청자${i + 1}`, text, platform: 'test'
        }));
        void this.ai.call('ingest_chat', { session_id: this.ai.sessionId ?? 'active', messages }).then((r) => {
            if (!r) this.announce('AI 서버에 연결되지 않음', '#e57373');
        });
    }

    simulateDonation (amount: number, text: string)
    {
        void this.ai.call('ingest_donation', {
            session_id: this.ai.sessionId ?? 'active',
            donation: { user_id: `test-donor-${Date.now()}`, nickname: '테스트후원자', amount, text }
        }).then((r) => {
            if (!r) this.announce('AI 서버에 연결되지 않음', '#e57373');
        });
    }

    //  게임에 웨이브 개념이 없어서 1분 = 1웨이브로 환산해 AI 에 전달
    get wave (): number
    {
        return 1 + Math.floor(this.elapsedMs / 60_000);
    }

    reportState ()
    {
        if (this.isGameOver)
        {
            return;
        }
        const bosses = this.bosses.group.getChildren().filter((b) => b.active).map((b) => (b as Boss).kind);
        void this.ai.reportState({
            wave: this.wave,
            player_hp: Math.max(0, this.player.hp),
            player_max_hp: this.stats.maxHp,
            player_level: this.experience.level,
            enemies_alive: this.enemies.aliveCount,
            score: this.kills,
            elapsed_sec: this.elapsedMs / 1000,
            extra: { bosses, final_boss: !!this.bosses.finalBoss, light_radius: Math.round(this.lighting.radius) }
        }, PLAYER_NICKNAME);
    }

    //  판이 끝나면 플레이 기록 + 세이브(최고 기록) 저장
    finishSession (cleared: boolean)
    {
        const result = this.result(cleared);
        void this.ai.endSession({
            status: cleared ? 'cleared' : 'dead',
            final_wave: this.wave,
            score: result.kills,
            kills: result.kills,
            level: result.level,
            ai_events_applied: this.audience.applied,
            extra: { survived_ms: Math.round(result.survivedMs) }
        });

        const prev = this.save?.data;
        const data: LanternSave = {
            plays: (prev?.plays ?? 0) + 1,
            clears: (prev?.clears ?? 0) + (cleared ? 1 : 0),
            bestSurvivedMs: Math.max(prev?.bestSurvivedMs ?? 0, Math.round(result.survivedMs)),
            bestKills: Math.max(prev?.bestKills ?? 0, result.kills),
            bestLevel: Math.max(prev?.bestLevel ?? 0, result.level),
            lastPlayedAt: new Date().toISOString()
        };
        void this.ai.save(SAVE_SLOT, data as unknown as Record<string, unknown>, this.save?.version ?? 0, '기록');
    }

    update (_time: number, delta: number)
    {
        if (this.isGameOver)
        {
            return;
        }

        this.elapsedMs += delta;
        const now = this.elapsedMs;     //  시간 기준은 게임 경과 시간 (레벨업 일시정지 중에는 멈춰 있음)

        while (this.pendingAudience.length > 0)
        {
            this.audience.apply(this.pendingAudience.shift()!);
        }

        this.updateMovement();
        this.enemies.update(delta, now);
        this.bosses.update(now);
        this.hazards.update(now);
        this.weapons.forEach((weapon) => weapon.update(now, delta));
        this.experience.update();
        this.updateWorld();
        this.updateHud();
    }

    //  배경 재배치 + 어둠/등불 (카메라가 플레이어를 정중앙에 두므로 화면 왼쪽 위 = 플레이어 - 화면 절반)
    updateWorld ()
    {
        const viewX = this.player.x - this.scale.width / 2;
        const viewY = this.player.y - this.scale.height / 2;
        this.background.update(viewX, viewY);
        this.lighting.update(this.elapsedMs, this.player.x, this.player.y, viewX, viewY);
    }

    // ---------------------------------------------------------------- 플레이어

    updateMovement ()
    {
        let dx = 0;
        let dy = 0;

        if (this.cursors.left.isDown || this.wasd.left.isDown) dx -= 1;
        if (this.cursors.right.isDown || this.wasd.right.isDown) dx += 1;
        if (this.cursors.up.isDown || this.wasd.up.isDown) dy -= 1;
        if (this.cursors.down.isDown || this.wasd.down.isDown) dy += 1;

        this.player.move(dx, dy);
    }

    onPlayerHit (damage: number, effects: HitEffects = {})
    {
        if (this.isGameOver || !this.player.takeDamage(damage))
        {
            return;
        }

        this.player.applyEffects(effects);
        this.cameras.main.shake(100, 0.005);

        if (this.player.isDead)
        {
            this.endGame();
        }
    }

    //  등불이 꺼짐 (사망)
    endGame ()
    {
        this.isGameOver = true;
        this.physics.pause();
        this.player.setTint(0x555566);
        this.lighting.fadeDarkness(1, 900);
        this.updateHud();
        this.finishSession(false);

        this.time.delayedCall(1200, () => this.scene.start('GameOver', this.result(false)));
    }

    result (cleared: boolean): GameResult
    {
        return { survivedMs: this.elapsedMs, kills: this.kills, level: this.experience.level, cleared };
    }

    // ---------------------------------------------------------------- 보스 / 후원

    //  후원이 들어왔을 때 (지금은 테스트 버튼, 나중에 미들웨어의 후원 이벤트와 연결)
    onDonation (amount: number, donor?: string)
    {
        if (!this.bosses.spawnMothQueen(amount, donor))
        {
            this.announce('나방 여왕을 더 부를 수 없음', '#b0bec5');
        }
    }

    onBossSpawned (boss: Boss)
    {
        switch (boss.kind)
        {
            case 'pilgrim':
                this.announce('밀랍 순례자가 다가온다', '#efe3c4');
                break;
            case 'moth':
                this.announce('재의 나방 여왕이 빛을 찾아왔다', '#d6d0de');
                break;
            case 'final':
                //  1페이즈 시작: 화면 가장자리부터 어둠이 차오르고, 다른 몬스터는 모두 사라짐
                this.announce('긴 밤이 내려온다', '#b39ddb');
                this.enemies.clearAll();
                this.enemies.spawning = false;
                this.hazards.clear();
                this.lighting.fadeDarkness(LIGHT.finalDarkness, 3000);
                break;
        }
    }

    onBossKilled (boss: Boss)
    {
        this.kills++;

        switch (boss.kind)
        {
            case 'pilgrim':
                this.experience.dropGem(boss.x, boss.y, boss.xp);
                break;
            case 'moth':
                //  날개에서 대량의 불씨가 쏟아짐 (일반 몬스터 30마리 분량)
                this.experience.burst(boss.x, boss.y, MOTH.dropEmbers);
                break;
            case 'final':
                this.playDawnEnding();
                break;
        }
    }

    //  엔딩: 화면 전체가 새벽빛으로 하얗게 덮임
    playDawnEnding ()
    {
        this.isGameOver = true;
        this.finishSession(true);
        this.physics.pause();
        this.hazards.clear();
        this.lighting.fadeDarkness(0, DAWN_MS);

        const { width, height } = this.scale;
        const dawn = this.add.rectangle(0, 0, width, height, 0xfff4dc)
            .setOrigin(0).setScrollFactor(0).setDepth(DEPTH.ending).setAlpha(0);
        const title = this.add.text(width / 2, height / 2 - 20, '새벽', {
            fontFamily: 'Arial Black', fontSize: 72, color: '#b8742a'
        }).setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH.ending).setAlpha(0);
        const line = this.add.text(width / 2, height / 2 + 50, '등불의 불씨는 옛 태양의 마지막 조각이었다', {
            fontFamily: 'Arial, sans-serif', fontSize: 22, color: '#8a5a2a'
        }).setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH.ending).setAlpha(0);

        this.tweens.add({ targets: dawn, alpha: 1, duration: DAWN_MS, ease: 'Sine.easeIn' });
        this.tweens.add({ targets: [title, line], alpha: 1, delay: DAWN_MS, duration: 1200 });
        this.time.delayedCall(DAWN_MS + 3000, () => this.scene.start('GameOver', this.result(true)));
    }

    //  화면 가운데에 잠깐 떴다가 사라지는 알림 문구
    announce (message: string, color: string)
    {
        const text = this.add.text(this.scale.width / 2, this.scale.height / 2 - 150, message, {
            fontFamily: 'Arial Black', fontSize: 34, color,
            stroke: '#000000', strokeThickness: 7
        }).setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH.announce);

        this.tweens.add({
            targets: text,
            alpha: 0,
            y: text.y - 30,
            delay: 1400,
            duration: 600,
            onComplete: () => text.destroy()
        });
    }

    // ---------------------------------------------------------------- 무기 / 레벨업

    createWeapon (id: WeaponId): Weapon
    {
        const ctx: WeaponContext = {
            scene: this, player: this.player, stats: this.stats, targets: this.targets, lighting: this.lighting
        };
        switch (id)
        {
            case 'lanternAura': return new LanternAura(ctx);
            case 'emberShot': return new EmberShot(ctx);
            case 'emberPool': return new EmberPool(ctx);
        }
    }

    onLevelUp ()
    {
        this.pendingLevelUps++;
        if (this.pendingLevelUps > 1)
        {
            return;     //  이미 레벨업 화면이 열려 있음 -> 선택이 끝나면 이어서 표시됨
        }

        const data: LevelUpData = {
            choices: rollUpgradeChoices(this.weapons, this.stats),
            onPick: (choice) => this.onUpgradePicked(choice)
        };
        this.scene.pause();
        this.scene.launch('LevelUp', data);
    }

    //  카드를 골랐을 때. 레벨업이 더 남아 있으면 다음 카드 목록을 돌려준다
    onUpgradePicked (choice: UpgradeChoice): UpgradeChoice[] | null
    {
        this.applyUpgrade(choice);
        this.pendingLevelUps--;
        this.updateHud();

        if (this.pendingLevelUps > 0)
        {
            return rollUpgradeChoices(this.weapons, this.stats);
        }

        this.scene.resume();
        return null;
    }

    applyUpgrade (choice: UpgradeChoice)
    {
        switch (choice.kind)
        {
            case 'weapon':
            {
                const owned = this.weapons.find((w) => w.id === choice.id);
                if (owned)
                {
                    owned.levelUp();
                }
                else
                {
                    this.weapons.push(this.createWeapon(choice.id));
                }
                break;
            }
            case 'passive':
                this.stats.levelUp(choice.id);
                if (choice.id === 'heart')
                {
                    this.player.heal(PASSIVES.heart.perLevel);
                }
                break;
            case 'heal':
                this.player.heal(FALLBACK_HEAL);
                break;
        }
    }

    // ---------------------------------------------------------------- HUD

    updateHud ()
    {
        this.hud.update({
            hp: this.player.hp,
            maxHp: this.stats.maxHp,
            playerX: this.player.x,
            playerY: this.player.y,
            level: this.experience.level,
            xp: this.experience.xp,
            xpToNext: this.experience.xpToNext,
            elapsedMs: this.elapsedMs,
            kills: this.kills,
            build: this.buildSummary()
        });
    }

    //  "불씨 탄 Lv.2" / "신발 Lv.1  힘 Lv.2" 형태의 보유 목록
    buildSummary (): string
    {
        const weapons = this.weapons.map((w) => `${w.name} Lv.${w.level}`).join('  ');
        const passives = PASSIVE_IDS
            .filter((id) => this.stats.level(id) > 0)
            .map((id) => `${PASSIVES[id].name} Lv.${this.stats.level(id)}`)
            .join('  ');
        return passives ? `${weapons}\n${passives}` : weapons;
    }
}
