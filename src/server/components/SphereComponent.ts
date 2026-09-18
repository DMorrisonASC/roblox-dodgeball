import { OnStart } from "@flamework/core";
import { Component, BaseComponent } from "@flamework/components";
import { Players } from "@rbxts/services";

@Component({
	tag: "Sphere",
})
export class SphereComponent extends BaseComponent<{}, BasePart> implements OnStart {
	public onStart(): void {
		this.instance.Touched.Connect((otherPart) => {
			const character = otherPart.FindFirstAncestorWhichIsA("Model");

            const humanoid = character?.FindFirstChildWhichIsA("Humanoid");

            const player = character ? Players.GetPlayerFromCharacter(character) : undefined;

            if (player) {
                print(`${this.instance.Name} touched ${otherPart.Name} of ${player.Name}`);
            }

            else if (character && humanoid) {
                print(`${this.instance.Name} touched ${otherPart.Name} of ${character.Name}`);
            }

            else {
                print(`${this.instance.Name} touched ${otherPart.Name}`);
            }
		});
	}
}