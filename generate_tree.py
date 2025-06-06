import os

# Output file
output_file = "tree.txt"

# Exclusions
excluded_dirs = {"node_modules", ".next", ".git", "logs"}
excluded_files = {"package-lock.json","generate_tree.py","combine_files.py"}

def write_tree(root_path, indent="", output=[]):
    try:
        items = sorted(os.listdir(root_path))
    except PermissionError:
        return

    for index, item in enumerate(items):
        item_path = os.path.join(root_path, item)
        is_last = (index == len(items) - 1)

        if item in excluded_dirs and os.path.isdir(item_path):
            continue
        if item in excluded_files and os.path.isfile(item_path):
            continue

        prefix = "└── " if is_last else "├── "
        output.append(f"{indent}{prefix}{item}")

        if os.path.isdir(item_path):
            next_indent = indent + ("    " if is_last else "│   ")
            write_tree(item_path, next_indent, output)

def main():
    output_lines = ["Project Tree (excluding node_modules, .next, package-lock.json):\n"]
    write_tree(".", "", output_lines)

    with open(output_file, "w", encoding="utf-8") as f:
        f.write("\n".join(output_lines))

    print(f"Tree saved to {output_file}")

if __name__ == "__main__":
    main()