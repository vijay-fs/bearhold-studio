class Function::
    def my_function(a,b):
        if a > b:
          return a-b
    def my_function2(my_function):
        print(my_function(5, 3))

object = Function()
object.my_function2(object.my_function)

# fun 1 (5, 3) -> fun 2 (fun1) - > print result 