package com.todo.app.ui.view

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.todo.app.data.model.Todo
import com.todo.app.ui.viewmodel.TodoViewModel
import java.time.LocalDate

@Composable
fun MatrixView(viewModel: TodoViewModel) {
    val todos by viewModel.todos.collectAsState()
    var showEditDialogFor by remember { mutableStateOf<Todo?>(null) }

    val sortedTodos = todos.sortedWith(TodoComparator)
    
    val todayStr = LocalDate.now().toString()
    val filteredTodos = sortedTodos.filter {
        val isOverdue = it.date != null && it.date!! < todayStr && !it.completed && !it.date!!.contains("-W") && it.date!!.length != 7
        it.date == todayStr || isOverdue || it.date == null
    }
    
    val q1 = filteredTodos.filter { it.importance >= 3 && it.urgency >= 3 }
    val q2 = filteredTodos.filter { it.importance >= 3 && it.urgency < 3 }
    val q3 = filteredTodos.filter { it.importance < 3 && it.urgency >= 3 }
    val q4 = filteredTodos.filter { it.importance < 3 && it.urgency < 3 }

    Column(modifier = Modifier.fillMaxSize()) {
        Row(modifier = Modifier.weight(1f)) {
            Quadrant(title = "重要 且 紧急", color = Color(0xFFF5222D), items = q1, viewModel = viewModel, modifier = Modifier.weight(1f)) { showEditDialogFor = it }
            Quadrant(title = "重要 不紧急", color = Color(0xFFFA8C16), items = q2, viewModel = viewModel, modifier = Modifier.weight(1f)) { showEditDialogFor = it }
        }
        Row(modifier = Modifier.weight(1f)) {
            Quadrant(title = "紧急 不重要", color = Color(0xFFFADB14), items = q3, viewModel = viewModel, modifier = Modifier.weight(1f)) { showEditDialogFor = it }
            Quadrant(title = "不重要 不紧急", color = Color(0xFF52C41A), items = q4, viewModel = viewModel, modifier = Modifier.weight(1f)) { showEditDialogFor = it }
        }
    }

    showEditDialogFor?.let { todo ->
        EditTodoDialog(
            todo = todo,
            onDismiss = { showEditDialogFor = null },
            onSave = { updated -> 
                viewModel.updateTodo(updated)
                showEditDialogFor = null 
            },
            onDelete = {
                viewModel.deleteTodo(todo.id)
                showEditDialogFor = null
            }
        )
    }
}

@Composable
fun Quadrant(
    title: String, 
    color: Color, 
    items: List<Todo>, 
    viewModel: TodoViewModel, 
    modifier: Modifier,
    onClick: (Todo) -> Unit
) {
    androidx.compose.material3.Surface(
        modifier = modifier.fillMaxSize().padding(4.dp),
        shape = androidx.compose.foundation.shape.RoundedCornerShape(12.dp),
        color = color.copy(alpha = 0.05f)
    ) {
        Column(modifier = Modifier.fillMaxSize()) {
            androidx.compose.material3.Surface(
                modifier = Modifier.fillMaxWidth(),
                color = color.copy(alpha = 0.15f)
            ) {
                Text(
                    text = title, 
                    color = color, 
                    style = MaterialTheme.typography.titleSmall,
                    modifier = Modifier.padding(vertical = 6.dp, horizontal = 12.dp)
                )
            }
            LazyColumn(modifier = Modifier.fillMaxSize().padding(4.dp)) {
                items(items) { todo ->
                    TodoItemRow(todo, viewModel) { onClick(todo) }
                }
            }
        }
    }
}
