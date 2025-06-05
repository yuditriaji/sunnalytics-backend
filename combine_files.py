import os

# Output file name
output_file = "all_files_combined.txt"

# Folders to exclude
excluded_dirs = {'.git', 'node_modules', 'prisma'}

# Extensions to exclude
excluded_exts = {'.md'}

# Specific filenames to exclude
excluded_files = {'.env', 'combine_files.py'}

with open(output_file, 'w', encoding='utf-8') as out:
    for root, dirs, files in os.walk(".", topdown=True):
        # Exclude specific folders
        dirs[:] = [d for d in dirs if d not in excluded_dirs]

        for file in files:
            filepath = os.path.join(root, file)

            # Skip excluded extensions or filenames
            if os.path.splitext(file)[1] in excluded_exts or file in excluded_files:
                continue

            try:
                with open(filepath, 'r', encoding='utf-8') as f:
                    # Add filename header
                    out.write(f"\n=== {filepath} ===\n")
                    out.write(f.read())
            except Exception as e:
                print(f"Skipped {filepath}: {e}")
