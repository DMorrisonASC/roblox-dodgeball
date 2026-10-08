<#
Alpha-bleed pass for the power icons (and anything else that gets resampled small).

**What it does.** Every fully transparent pixel (alpha = 0) is given the colour of the nearest
opaque pixel, in BFS order, leaving its alpha at 0. Nothing else is touched: opaque pixels keep
their colour, semi-transparent pixels keep both their colour and their alpha.

**Why that is worth doing.** A transparent pixel is *invisible* wherever it is drawn, but it is not
*ignored*: downsizing an image averages the pixels around each sample, and a pixel with alpha 0
still contributes its RGB to that average. The power icons are 1254px square and the HUD draws them
at 56px, so ~22 source pixels become one on screen — which means the colour carried by the
invisible pixels decides what the art's *edges* blend towards. If that colour is the canvas the art
was drawn on, the icon wears a halo of it; if it is the art's own edge colour, it does not. That is
the whole point: the file stops depending on what is behind it.

**What it is not.** It does not remove a background — a pixel that is fully opaque stays opaque, no
matter what colour it is. A flattened export is flattened, and this pass will not rescue it. It
also does nothing about an alpha channel that is missing: `Format24bppRgb` has nowhere to put a
transparent pixel in the first place.

**Usage.** `.\tools\alpha-bleed.ps1` (defaults to `assets\icons`), or `-Folder <path>`. Writes
`<name>-bleed.png` next to each input and never overwrites anything: the source file remains the
source, so a run can be compared against it or repeated after a re-export.
#>
param([string]$Folder = "assets\icons")

Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;

public static class AlphaBleed
{
    public static string Run(string input, string output)
    {
        using (var src = new Bitmap(input))
        {
            int w = src.Width, h = src.Height, n = w * h;
            var px = new Color[n];
            for (int i = 0; i < n; i++) px[i] = src.GetPixel(i % w, i / w);

            long count = 0, r0 = 0, g0 = 0, b0 = 0;
            for (int i = 0; i < n; i++)
            {
                if (px[i].A != 0) continue;
                count++; r0 += px[i].R; g0 += px[i].G; b0 += px[i].B;
            }

            var visited = new bool[n];
            var queue = new Queue<int>();
            for (int i = 0; i < n; i++)
            {
                if (px[i].A == 0) continue;
                visited[i] = true;
                queue.Enqueue(i);
            }

            while (queue.Count > 0)
            {
                int i = queue.Dequeue(), x = i % w, y = i / w;
                Color c = px[i];
                if (x > 0) Spread(i - 1, c, px, visited, queue);
                if (x < w - 1) Spread(i + 1, c, px, visited, queue);
                if (y > 0) Spread(i - w, c, px, visited, queue);
                if (y < h - 1) Spread(i + w, c, px, visited, queue);
            }

            long r1 = 0, g1 = 0, b1 = 0;
            for (int i = 0; i < n; i++)
            {
                if (px[i].A != 0) continue;
                r1 += px[i].R; g1 += px[i].G; b1 += px[i].B;
            }

            using (var dst = new Bitmap(w, h, PixelFormat.Format32bppArgb))
            {
                for (int i = 0; i < n; i++) dst.SetPixel(i % w, i / w, px[i]);
                dst.Save(output, ImageFormat.Png);
            }

            string mean = count == 0
                ? "none"
                : (r0 / count) + "," + (g0 / count) + "," + (b0 / count) + " -> " + (r1 / count) + "," + (g1 / count) + "," + (b1 / count);
            return count + "|" + mean + "|" + w + "x" + h;
        }
    }

    static void Spread(int j, Color c, Color[] px, bool[] visited, Queue<int> queue)
    {
        if (visited[j]) return;
        visited[j] = true;
        px[j] = Color.FromArgb(px[j].A, c.R, c.G, c.B);
        queue.Enqueue(j);
    }
}
'@

$files = @(Get-ChildItem "$Folder\*.png" | Where-Object { $_.BaseName -notlike "*-bleed" })
if ($files.Count -eq 0) {
	Write-Output "no PNGs in $Folder"
	return
}

foreach ($file in $files) {
	$out = Join-Path $Folder "$($file.BaseName)-bleed.png"
	$result = [AlphaBleed]::Run($file.FullName, $out).Split("|")

	Write-Output "$($file.Name)  ->  $([System.IO.Path]::GetFileName($out))"
	Write-Output "    invisible pixels given a colour: $($result[0])"
	Write-Output "    their mean RGB: $($result[1])"
	Write-Output "    output: $($result[2]), written"
}
