import { OnStart } from "@flamework/core";
import { Component, BaseComponent } from "@flamework/components";
import { Players } from "@rbxts/services";

interface BallAttributes {
    Armed: Boolean;
}

@Component({
	tag: "Ball",
    defaults: {Armed: false},
})

export class BallComponent extends BaseComponent<BallAttributes, BasePart> implements OnStart {
	onStart(): void {
        this.instance.Touched.Connect((otherPart) => {
            this.handleTouch(otherPart);
            this.logTouch(otherPart);
		}); 

	}

    private handleTouch(otherPart: BasePart): void {
        const character = otherPart.FindFirstAncestorWhichIsA("Model");
        const humanoid = character?.FindFirstChildWhichIsA("Humanoid");
        const player = character ? Players.GetPlayerFromCharacter(character) : undefined;

        
        if (this.isPlayer(otherPart) || this.isNpc(otherPart)) {
            if (this.instance.GetAttribute("Armed") && this.instance.GetAttribute("ThrowerId") !== player?.UserId) {
                humanoid?.TakeDamage(1000);
            }
        }

        else {
            this.instance.SetAttribute("Armed", false);
        }
    }

    private logTouch(otherPart: BasePart): void {
        const character = otherPart.FindFirstAncestorWhichIsA("Model");

        const player = character ? Players.GetPlayerFromCharacter(character) : undefined;

        if (this.isPlayer(otherPart)) {
            print(`${this.instance.Name} touched ${otherPart.Name} of ${player?.Name}`);
        }

        else if (this.isNpc(otherPart)) {
            print(`${this.instance.Name} touched ${otherPart.Name} of ${character?.Name}`);
        }

        else {
            print(`${this.instance.Name} touched ${otherPart.Name}`);
        }
    }

    private isPlayer(otherPart: BasePart): boolean {
        const character = otherPart.FindFirstAncestorWhichIsA("Model");

        const player = character ? Players.GetPlayerFromCharacter(character) : undefined;
        
        if (player) {
            return true;
        }

        return false;
    }

    private isNpc(otherPart: BasePart): boolean {
        const character = otherPart.FindFirstAncestorWhichIsA("Model"); 
        const humanoid = character?.FindFirstChildWhichIsA("Humanoid");
        const player = character ? Players.GetPlayerFromCharacter(character) : undefined;

        if (humanoid && !player) {
            return true;
        }

        return false;
    }
}