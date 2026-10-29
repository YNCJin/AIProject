import { Scene } from 'phaser';
import { UpgradeChoice } from '../systems/Upgrades';

export interface LevelUpData
{
    choices: UpgradeChoice[];
    //  카드를 고르면 호출. 레벨업이 더 남아 있으면 다음 카드 목록을, 끝났으면 null 을 돌려준다
    onPick: (choice: UpgradeChoice) => UpgradeChoice[] | null;
}

const CARD_WIDTH = 260;
const CARD_HEIGHT = 300;
const CARD_GAP = 30;
const KEY_NAMES = ['ONE', 'TWO', 'THREE'];

//  레벨업 시 게임 위에 뜨는 카드 3택 1 화면 (Game 씬은 일시정지됨)
//  마우스 클릭 또는 숫자키 1 / 2 / 3 으로 선택
export class LevelUp extends Scene
{
    levelUpData: LevelUpData;
    cards: Phaser.GameObjects.Container[];
    choices: UpgradeChoice[];

    constructor ()
    {
        super('LevelUp');
    }

    init (data: LevelUpData)
    {
        this.levelUpData = data;
    }

    create ()
    {
        const { width, height } = this.scale;

        this.add.rectangle(0, 0, width, height, 0x000000, 0.6).setOrigin(0);
        this.add.text(width / 2, 150, 'LEVEL UP!', {
            fontFamily: 'Arial Black', fontSize: 56, color: '#ffeb3b',
            stroke: '#000000', strokeThickness: 8
        }).setOrigin(0.5);

        KEY_NAMES.forEach((key, i) => {
            this.input.keyboard!.on(`keydown-${key}`, () => this.pick(i));
        });

        this.cards = [];
        this.showChoices(this.levelUpData.choices);
    }

    showChoices (choices: UpgradeChoice[])
    {
        this.choices = choices;
        this.cards.forEach((card) => card.destroy());

        const { width, height } = this.scale;
        const totalWidth = choices.length * CARD_WIDTH + (choices.length - 1) * CARD_GAP;
        const startX = (width - totalWidth) / 2 + CARD_WIDTH / 2;

        this.cards = choices.map((choice, i) =>
            this.createCard(startX + i * (CARD_WIDTH + CARD_GAP), height / 2 + 60, choice, i)
        );
    }

    createCard (x: number, y: number, choice: UpgradeChoice, index: number): Phaser.GameObjects.Container
    {
        const bg = this.add.rectangle(0, 0, CARD_WIDTH, CARD_HEIGHT, 0x22223a)
            .setStrokeStyle(3, 0x8888aa);

        const keyText = this.add.text(-CARD_WIDTH / 2 + 12, -CARD_HEIGHT / 2 + 10, `[${index + 1}]`, {
            fontFamily: 'Arial', fontSize: 18, color: '#aaaacc'
        });

        const kindText = this.add.text(0, -CARD_HEIGHT / 2 + 50, kindLabel(choice), {
            fontFamily: 'Arial', fontSize: 16, color: '#aaaacc'
        }).setOrigin(0.5);

        const nameText = this.add.text(0, -CARD_HEIGHT / 2 + 85, choice.name, {
            fontFamily: 'Arial Black', fontSize: 30, color: '#ffffff'
        }).setOrigin(0.5);

        const levelText = this.add.text(0, -CARD_HEIGHT / 2 + 130, choice.levelText, {
            fontFamily: 'Arial Black', fontSize: 20,
            color: choice.levelText === 'NEW' ? '#ffeb3b' : '#81c784'
        }).setOrigin(0.5);

        const descText = this.add.text(0, 30, choice.description, {
            fontFamily: 'Arial, sans-serif', fontSize: 18, color: '#ffffff', align: 'center',
            lineSpacing: 6, wordWrap: { width: CARD_WIDTH - 30, useAdvancedWrap: true }
        }).setOrigin(0.5, 0);

        bg.setInteractive({ useHandCursor: true })
            .on('pointerover', () => bg.setStrokeStyle(3, 0xffeb3b))
            .on('pointerout', () => bg.setStrokeStyle(3, 0x8888aa))
            .on('pointerdown', () => this.pick(index));

        return this.add.container(x, y, [bg, keyText, kindText, nameText, levelText, descText]);
    }

    pick (index: number)
    {
        const choice = this.choices[index];
        if (!choice)
        {
            return;
        }

        const next = this.levelUpData.onPick(choice);
        if (next)
        {
            this.showChoices(next);     //  레벨업이 연속으로 쌓여 있으면 바로 다음 선택
        }
        else
        {
            this.scene.stop();
        }
    }
}

function kindLabel (choice: UpgradeChoice): string
{
    switch (choice.kind)
    {
        case 'weapon': return '무기';
        case 'passive': return '패시브';
        case 'heal': return '아이템';
    }
}
