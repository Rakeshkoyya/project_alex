# Python fundamentals

## Foundations: what a program is
A program is a list of precise instructions the computer runs in order, top to bottom. Python reads each line, does what it says, and moves on.

## Variables and types
A variable is a name that refers to a value: age = 14. Common types are int (14), float (3.5), str ("hello") and bool (True/False). type(x) tells you the type.

## Expressions and operators
Arithmetic: + - * / // % **. Comparison: == != < > <= >=, which produce booleans. Logic: and, or, not.

## Conditionals
if temperature > 30:
    print("hot")
elif temperature > 15:
    print("mild")
else:
    print("cold")
Indentation defines which lines belong to each branch.

## Loops
for i in range(5): repeats with i = 0..4. while condition: repeats while the condition stays True. break exits a loop early.

## Lists and dictionaries
A list holds ordered items: nums = [3, 1, 4]; nums[0] is 3; nums.append(1). A dict maps keys to values: ages = {"ana": 14}; ages["ana"] is 14.

## Functions
def area(w, h):
    return w * h
Functions package reusable steps; parameters are inputs, return gives back a result.
