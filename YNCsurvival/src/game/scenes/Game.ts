import { Scene } from 'phaser';
import { ENEMY, FALLBACK_HEAL, SHOW_DEBUG_BUTTONS, WORLD_SIZE } from '../config';
import { PASSIVE_IDS, PASSIVES } from '../data/passives';
import { WeaponId } from '../data/weapons';
import { Boss } from '../entities/Boss';
import { Player } from '../entities/Player';
import { BossManager } from '../systems/BossManager';
import { EnemySpawner } from '../systems/EnemySpawner';
import { Experience } from '../systems/Experience';
import { PlayerStats } from '../systems/PlayerStats';
import { Targets } from '../systems/Targets';
import { rollUpgradeChoices, UpgradeChoice } from '../systems/Upgrades';
import { createDebugButtons } from '../ui/DebugButtons';
import { Hud } from '../ui/Hud';
import { MagicBolt } from '../weapons/MagicBolt';
import { Weapon, WeaponContext } from '../weapons/Weapon';
import { LevelUpData } from './LevelUp';

export interface GameResult
{
    survivedMs: number;
    kills: number;
    level: number;
    cleared: boolean;   //  최종 보스 처치 여부
}

//  게임 본체: 각 시스템을 만들고 연결하는 역할만 한다
//  세부 동작은 entities / systems / weapons / ui 폴더 참고
export class Game extends Scene
{
    stats: PlayerStats;
    player: Player;
    enemies: EnemySpawner;
    bosses: BossManager;
    targets: Targets;
    experience: Experience;
    weapons: Weapon[];
    hud: Hud;

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

        //  월드 & 바닥
        this.physics.world.setBounds(0, 0, WORLD_SIZE, WORLD_SIZE);
        this.add.tileSprite(0, 0, WORLD_SIZE, WORLD_SIZE, 'ground').setOrigin(0);

        //  플레이어
        this.stats = new PlayerStats();
        this.player = new Player(this, WORLD_SIZE / 2, WORLD_SIZE / 2, this.stats);
        this.cameras.main.setBounds(0, 0, WORLD_SIZE, WORLD_SIZE);
        this.cameras.main.startFollow(this.player, true);

        //  적 / 경험치
        this.enemies = new EnemySpawner(this, this.player, (x, y, xp) => {
            this.kills++;
            this.experience.dropGem(x, y, xp);
        });
        this.experience = new Experience(this, this.player, () => this.onLevelUp());

        //  보스 (중간 보스 / 최종 보스)
        this.bosses = new BossManager(this, this.player, {
            onHitPlayer: (damage) => this.onPlayerHit(damage),
            onBossSpawned: (boss) => this.announce(
                boss.kind === 'final' ? '최종 보스 등장!' : '중간 보스 등장!',
                boss.kind === 'final' ? '#ff5252' : '#ce93d8'
            ),
            onBossKilled: (boss) => this.onBossKilled(boss)
        });
        this.targets = new Targets(this.enemies, this.bosses);

        //  무기 (시작 무기: 매직 볼트)
        this.weapons = [this.createWeapon('magicBolt')];

        //  적 / 보스와 닿으면 피해
        this.physics.add.overlap(this.player, this.enemies.group, () => {
            this.onPlayerHit(ENEMY.contactDamage);
        });
        this.physics.add.overlap(this.player, this.bosses.group, (_player, boss) => {
            this.onPlayerHit((boss as Boss).contactDamage);
        });

        //  입력 (방향키 + WASD)
        const keyboard = this.input.keyboard!;
        this.cursors = keyboard.createCursorKeys();
        this.wasd = keyboard.addKeys({ up: 'W', down: 'S', left: 'A', right: 'D' }) as Game['wasd'];

        this.hud = new Hud(this);
        this.updateHud();

        if (SHOW_DEBUG_BUTTONS)
        {
            createDebugButtons(this, [
                { label: '중간 보스 소환', onClick: () => this.bosses.spawnMidBoss() ?? this.announce('중간 보스 최대 수 도달', '#b0bec5') },
                { label: '최종 보스 소환', onClick: () => this.bosses.spawnFinalBoss() ?? this.announce('최종 보스가 이미 있음', '#b0bec5') }
            ]);
        }
    }

    update (_time: number, delta: number)
    {
        if (this.isGameOver)
        {
            return;
        }

        this.elapsedMs += delta;

        this.updateMovement();
        this.enemies.update(delta, this.elapsedMs);
        this.bosses.update(this.elapsedMs);
        //  시간 기준은 게임 경과 시간 (레벨업 일시정지 중에는 멈춰 있음)
        this.weapons.forEach((weapon) => weapon.update(this.elapsedMs, delta));
        this.experience.update();
        this.updateHud();
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

    onPlayerHit (damage: number)
    {
        if (this.isGameOver || !this.player.takeDamage(damage))
        {
            return;
        }

        this.cameras.main.shake(100, 0.005);

        if (this.player.isDead)
        {
            this.endGame();
        }
    }

    endGame (cleared = false)
    {
        this.isGameOver = true;
        this.physics.pause();
        if (!cleared)
        {
            this.player.setTint(0xff0000);
        }
        this.updateHud();

        const result: GameResult = {
            survivedMs: this.elapsedMs,
            kills: this.kills,
            level: this.experience.level,
            cleared
        };
        if (cleared)
        {
            this.announce('CLEAR!', '#ffeb3b');
        }
        this.time.delayedCall(cleared ? 2000 : 1000, () => this.scene.start('GameOver', result));
    }

    // ---------------------------------------------------------------- 보스

    onBossKilled (boss: Boss)
    {
        this.kills++;

        if (boss.kind === 'final')
        {
            this.endGame(true);
            return;
        }

        this.experience.dropGem(boss.x, boss.y, boss.xp);
    }

    //  화면 가운데에 잠깐 떴다가 사라지는 알림 문구
    announce (message: string, color: string)
    {
        const text = this.add.text(this.scale.width / 2, this.scale.height / 2 - 140, message, {
            fontFamily: 'Arial Black', fontSize: 40, color,
            stroke: '#000000', strokeThickness: 8
        }).setOrigin(0.5).setScrollFactor(0).setDepth(150);

        this.tweens.add({
            targets: text,
            alpha: 0,
            y: text.y - 30,
            delay: 1200,
            duration: 600,
            onComplete: () => text.destroy()
        });
    }

    // ---------------------------------------------------------------- 무기 / 레벨업

    createWeapon (id: WeaponId): Weapon
    {
        const ctx: WeaponContext = { scene: this, player: this.player, stats: this.stats, targets: this.targets };
        switch (id)
        {
            case 'magicBolt': return new MagicBolt(ctx);
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

    //  "매직 볼트 Lv.2" / "신발 Lv.1  힘 Lv.2" 형태의 보유 목록
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
