from pathlib import Path

from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas


def main() -> None:
    output = Path(r"C:\Users\65839\Desktop\Vibe\reader\sample_50000_words.pdf")

    intro = (
        "This is a large text-only PDF for testing the Reader app. "
        "It is intentionally verbose to reach about fifty thousand words. "
        "The paragraphs below repeat with minor variations to provide a stable test input."
    )

    base_paragraph = (
        "Speed reading helps you focus on the core of each word while maintaining comprehension. "
        "As you progress, the rhythm of words can feel smoother and more consistent. "
        "These sentences are deliberately straightforward, using plain words and punctuation. "
        "The goal is to provide a clean, predictable text stream for word-by-word highlighting. "
        "Adjust the words-per-minute setting to explore different pacing and comfort levels. "
        "If the text feels too fast, lower the WPM and observe the difference in retention. "
        "If it feels too slow, increase the WPM and note how the focus point guides attention. "
        "This is only a test document, so you can safely explore different settings. "
        "Each paragraph is similar to keep the content easy to scan while still being long enough. "
        "End of paragraph."
    )

    target_words = 50000
    words = intro.split()
    paragraph_index = 1
    paragraphs = []
    while len(words) < target_words:
        paragraph = f"Paragraph {paragraph_index}: {base_paragraph}"
        paragraphs.append(paragraph)
        words.extend(paragraph.split())
        paragraph_index += 1

    full_text = intro + "\n\n" + "\n\n".join(paragraphs)

    c = canvas.Canvas(str(output), pagesize=letter)
    page_width, page_height = letter
    margin = 72
    line_height = 14

    lines = []
    for paragraph in full_text.split("\n"):
        if not paragraph:
            lines.append("")
            continue
        words = paragraph.split(" ")
        line = ""
        for word in words:
            test_line = (line + " " + word).strip()
            if c.stringWidth(test_line) <= (page_width - 2 * margin):
                line = test_line
            else:
                lines.append(line)
                line = word
        if line:
            lines.append(line)

    y = page_height - margin
    for line in lines:
        if y < margin:
            c.showPage()
            y = page_height - margin
        c.drawString(margin, y, line)
        y -= line_height

    c.save()
    print(output)


if __name__ == "__main__":
    main()
